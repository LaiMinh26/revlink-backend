// npm install express mysql2 cors bcrypt
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const bcrypt = require('bcrypt');
require('dotenv').config();

// 1. KHỞI TẠO APP TRƯỚC TIÊN
const app = express();

app.use(cors({
  origin: [
    'http://localhost:5173', 
    'http://localhost:3000', 
    'https://influencer-platform-xi.vercel.app' // Thay bằng link Vercel hiện tại của bạn
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
})); // cổng Vite / CRA
app.use(express.json());
 
const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
  dateStrings: true
});
 
// ---------- Tiện ích ----------
// Đổi lỗi kỹ thuật của MySQL thành câu dễ hiểu cho giao diện
function friendly(err) {
  const m = err.sqlMessage || err.message || 'Lỗi không xác định';
  if (m.includes('ck_cmp_budget')) return 'Thù lao cơ bản × số Reviewer tối đa vượt quá ngân sách!';
  if (m.includes('ck_cmp_dates')) return 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu!';
  if (m.includes('sample_products')) return 'Sản phẩm mẫu đã hết hàng trong kho!';
  if (m.includes('Duplicate entry')) {
  if (m.includes('tax_code')) return 'Mã số thuế đã được đăng ký!';
  if (m.includes('brand_code')) return 'Mã thương hiệu đã tồn tại!';
  if (m.includes('id_card')) return 'Số CCCD đã được đăng ký!';
  }
  return m; // lời nhắn từ trigger (SIGNAL) đã là tiếng Việt
}
 
async function nextId(conn, table, prefix) {
  const [[{ n }]] = await conn.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(id, ${prefix.length + 1}) AS UNSIGNED)), 0) + 1 AS n FROM ${table}`
  );
  return prefix + String(n).padStart(3, '0');
}
 
// ---------- Đăng nhập (dùng bảng accounts, mật khẩu BCrypt) ----------
app.post('/api/login', async (req, res) => {
  const { username, password, role } = req.body;
  const [rows] = await db.query(
    'SELECT password_hash, role, entity_id FROM accounts WHERE username = ? AND role = ?',
    [username, role]
  );
  if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
    return res.status(401).json({ error: 'Sai tài khoản, mật khẩu hoặc vai trò đã chọn.' });
  res.json({ role: rows[0].role, entityId: rows[0].entity_id || '', username });
});
 
// ---------- Tải toàn bộ dữ liệu cho giao diện (đặt alias về camelCase đúng như App.jsx) ----------
app.get('/api/data', async (req, res) => {
  try {
    // 1. TÌM CÁC BÀI ĐĂNG KÝ QUÁ HẠN MÀ CHƯA NỘP BÀI
    await db.query('CALL sp_scan_overdue()');
    
    const [brands] = await db.query(`
      SELECT id, tax_code AS taxCode, name, brand_code AS brandCode, industry, address,
             phone, email, representative, rating, status FROM brands ORDER BY id`);
 
    const [reviewers] = await db.query(`
      SELECT id, id_card AS idCard, name, dob, gender, hometown, phone, email,
             bank_account AS bankAccount, social_link AS socialLink, platform, followers,
             specialty, rank_level AS \`rank\`, reputation_score AS reputationScore, status
      FROM reviewers ORDER BY id`);
 
    const [campaigns] = await db.query(`
      SELECT c.id, c.brand_id AS brandId, b.name AS brandName, c.title, c.type,
             c.start_date AS startDate, c.end_date AS endDate, c.budget,
             c.base_salary AS baseSalary, c.max_reviewers AS maxReviewers,
             c.min_rank AS minRankRequired, c.status
      FROM campaigns c JOIN brands b ON b.id = c.brand_id ORDER BY c.id DESC`);
 
    const [samples] = await db.query(`
      SELECT id, brand_id AS brandId, name, price, stock, usage_guide AS usageGuide
      FROM sample_products ORDER BY id`);
 
    // Thù lao +10% (nộp trước hạn từ 3 ngày) được tính từ ngày tháng, không tin dữ liệu client gửi
    const [participations] = await db.query(`
      SELECT p.id, p.campaign_id AS campaignId, p.reviewer_id AS reviewerId, r.name AS reviewerName,
             DATE_FORMAT(p.register_time, '%Y-%m-%d %H:%i') AS registerTime,
             DATE_FORMAT(p.submit_time,   '%Y-%m-%d %H:%i') AS submitTime,
             p.status, p.submission_link AS submissionLink,
             p.views, p.likes, p.shares, p.total_interactions AS totalInteractions,
             COALESCE(p.brand_rating, 0) AS brandRating,
             COALESCE(p.cancel_reason, '') AS cancelReason,
             IF(p.submit_time IS NOT NULL AND DATEDIFF(c.end_date, DATE(p.submit_time)) >= 3, 0.1, 0) AS timeBonusRatio
      FROM participations p
      JOIN reviewers r ON r.id = p.reviewer_id
      JOIN campaigns c ON c.id = p.campaign_id
      ORDER BY p.register_time DESC, p.id DESC`);
 
    const [ps] = await db.query('SELECT participation_id, sample_id FROM participation_samples');
    const [cs] = await db.query('SELECT campaign_id, sample_id FROM campaign_samples');
 
    brands.forEach(b => (b.rating = Number(b.rating)));
    participations.forEach(p => {
      p.timeBonusRatio = Number(p.timeBonusRatio);
      p.samplesReceived = ps.filter(x => x.participation_id === p.id).map(x => x.sample_id);
    });
    campaigns.forEach(c => {
      c.sampleIds = cs.filter(x => x.campaign_id === c.id).map(x => x.sample_id);
    });
 
    res.json({ brands, reviewers, campaigns, samples, participations });
  } catch (err) {
    res.status(500).json({ error: friendly(err) });
  }
});

// ĐĂNG KÝ TÀI KHOẢN
app.post('/api/register', async (req, res) => {
  const body = req.body;
  if (!['BRAND', 'REVIEWER'].includes(body.role))
    return res.status(400).json({ error: 'Vai trò đăng ký không hợp lệ.' });
  if (!body.username || !body.password || body.password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự.' });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const { 
      username, password, role, name, phone, email, 
      // Dành cho Brand
      industry, taxCode, brandCode, address, representative,
      // Dành cho Reviewer
      idCard, platform, followers, specialty, socialLink 
    } = req.body;

    // 1. Kiểm tra trùng username
    const [existing] = await conn.query('SELECT username FROM accounts WHERE username = ?', [username]);
    if (existing.length > 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại!' });
    }

    let entityId = null;

    // 2. Sinh mã ID dạng VARCHAR(10) tự động (VD: BRD004, REV005) và chèn dữ liệu
    if (role === 'BRAND') {
      entityId = await nextId(conn, 'brands', 'BRD');
      await conn.query(
        `INSERT INTO brands (id, tax_code, name, brand_code, industry, address, phone, email, representative, rating, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 5.0, 'Hoạt động')`,
        [
          entityId,
          taxCode || `MST${Date.now().toString().slice(-7)}`,
          name,
          brandCode || `BR_${Date.now().toString().slice(-5)}`,
          industry || 'Khác',
          address || 'Chưa cập nhật',
          phone,
          email || '',
          representative || name
        ]
      );
    } else if (role === 'REVIEWER') {
      entityId = await nextId(conn, 'reviewers', 'REV');
      await conn.query(
        `INSERT INTO reviewers (id, id_card, name, phone, email, social_link, platform, followers, specialty, rank_level, reputation_score, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Junior', 100, 'Hoạt động')`,
        [
          entityId,
          idCard || Date.now().toString().slice(-12),
          name,
          phone,
          email || '',
          socialLink || '',
          platform || 'TikTok',
          Number(followers) || 1000,
          specialty || 'Tổng hợp'
        ]
      );
    }

    // 3. Mã hóa mật khẩu và lưu vào bảng accounts (cột password_hash)
    const hashedPassword = await bcrypt.hash(password, 10);
    await conn.query(
      'INSERT INTO accounts (username, password_hash, role, entity_id) VALUES (?, ?, ?, ?)',
      [username, hashedPassword, role, entityId]
    );

    await conn.commit();
    res.json({ ok: true, message: 'Đăng ký thành công!', entityId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: friendly(err) });
  } finally {
    conn.release();
  }
});

// ---------- Đăng ký chiến dịch ----------
// Trigger trong MySQL kiểm tra: điểm uy tín, cấp bậc, tối đa 2 lần, đủ chỗ.
// Đăng ký xong vào thẳng "Đang thực hiện" và được cấp mẫu (giống logic cũ trong App.jsx).
app.post('/api/participations', async (req, res) => {
  const { campaignId, reviewerId } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const id = await nextId(conn, 'participations', 'PAR');
    await conn.query(
      `INSERT INTO participations (id, campaign_id, reviewer_id, status) VALUES (?, ?, ?, 'Đang thực hiện')`,
      [id, campaignId, reviewerId]
    );
    await conn.query(
      `INSERT INTO participation_samples (participation_id, sample_id)
       SELECT ?, sample_id FROM campaign_samples WHERE campaign_id = ?`,
      [id, campaignId]
    );
    await conn.commit();
    res.json({ id });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: friendly(err) });
  } finally {
    conn.release();
  }
});
 
// ---------- Nộp link nghiệm thu ----------
// total_interactions là cột tự tính (views + likes + shares) nên không ghi trực tiếp.
app.put('/api/participations/:id/submit', async (req, res) => {
  const { submissionLink, views = 0, likes = 0, shares = 0 } = req.body;
  try {
    const [r] = await db.query(
      `UPDATE participations
          SET submit_time = NOW(), submission_link = ?, views = ?, likes = ?, shares = ?, status = 'Đã nộp bài'
        WHERE id = ? AND status = 'Đang thực hiện'`,
      [submissionLink, views, likes, shares, req.params.id]
    );
    if (!r.affectedRows) return res.status(400).json({ error: 'Lượt tham gia không ở trạng thái Đang thực hiện.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: friendly(err) });
  }
});
 
// ---------- Nhãn hàng duyệt và chấm sao ----------
app.put('/api/participations/:id/approve', async (req, res) => {
  try {
    const parId = req.params.id;
    const rating = Number(req.body.brandRating);

    // 1. Cập nhật trạng thái bài viết thành 'Đã hoàn thành' và lưu số sao
    const [r] = await db.query(
      `UPDATE participations SET status = 'Đã hoàn thành', brand_rating = ?
       WHERE id = ? AND status = 'Đã nộp bài'`,
      [rating, parId]
    );

    if (!r.affectedRows) {
      return res.status(400).json({ error: 'Bài chưa ở trạng thái Đã nộp bài.' });
    }

    // 2. Tự động cộng hoặc trừ điểm uy tín dựa vào đánh giá của nhãn hàng
    if (rating >= 4) {
      // Làm tốt (4 - 5 sao): Tự động cộng 5 điểm uy tín (tối đa 100)
      await db.query(
        `UPDATE reviewers 
         SET reputation_score = LEAST(100, reputation_score + 5) 
         WHERE id = (SELECT reviewer_id FROM participations WHERE id = ?)`,
        [parId]
      );
    } else if (rating <= 2) {
      // Làm tệ (1 - 2 sao): Tự động trừ 10 điểm uy tín và khóa tài khoản nếu < 50 điểm
      await db.query(
        `UPDATE reviewers 
         SET reputation_score = GREATEST(0, reputation_score - 10)
         WHERE id = (SELECT reviewer_id FROM participations WHERE id = ?)`,
        [parId]
      );
    }
    // Nếu đánh giá 3 sao (mức trung bình): Giữ nguyên điểm uy tín

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: friendly(err) });
  }
});
 
// ---------- Phạt: hủy lượt tham gia ----------
// Việc trừ 10 điểm và tự khóa khi dưới 50 điểm do TRIGGER trong MySQL làm,
// nên ở đây chỉ hủy lượt tham gia (không trừ điểm lần nữa để tránh phạt đôi).
app.post('/api/reviewers/penalty', async (req, res) => {
  const { participationId, reason } = req.body;
  try {
    const [r] = await db.query(
      `UPDATE participations SET status = 'Bị hủy', cancel_reason = ?
        WHERE id = ? AND status IN ('Chờ duyệt', 'Đang thực hiện')`,
      [reason, participationId]
    );
    if (!r.affectedRows) return res.status(400).json({ error: 'Lượt tham gia này không thể bị phạt.' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: friendly(err) });
  }
});
 
// ---------- Tạo chiến dịch ----------
app.post('/api/campaigns', async (req, res) => {
  const b = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const id = await nextId(conn, 'campaigns', 'CMP');
    await conn.query(
      `INSERT INTO campaigns (id, brand_id, title, type, start_date, end_date, budget, base_salary, max_reviewers, min_rank)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, b.brandId, b.title, b.type, b.startDate, b.endDate, b.budget, b.baseSalary, b.maxReviewers, b.minRankRequired]
    );
    for (const sid of b.sampleIds || []) {
      await conn.query('INSERT INTO campaign_samples (campaign_id, sample_id) VALUES (?, ?)', [id, sid]);
    }
    await conn.commit();
    res.json({ id });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: friendly(err) });
  } finally {
    conn.release();
  }
});

app.put('/api/reviewers/:id/unlock', async (req, res) => {
  try {
    await db.query(
      `UPDATE reviewers SET status = 'Hoạt động', reputation_score = 60 WHERE id = ?`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: friendly(err) });
  }
});

// Rút tiền
app.post('/api/payouts', async (req, res) => {
  const { reviewerId, amount } = req.body;
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Kiểm tra thông tin ngân hàng của reviewer
    const [[rev]] = await conn.query('SELECT bank_account, name FROM reviewers WHERE id = ?', [reviewerId]);
    if (!rev || !rev.bank_account) {
      return res.status(400).json({ error: 'Bạn chưa cập nhật thông tin tài khoản ngân hàng trong hồ sơ!' });
    }

    // 2. Tính số dư khả dụng
    const [[earnings]] = await conn.query(`
      SELECT 3000000 + COALESCE(SUM(v.total_pay), 0) AS total_income
      FROM reviewers r
      JOIN participations p ON p.reviewer_id = r.id
      LEFT JOIN v_participation_pay v ON v.participation_id = p.id
      WHERE r.id = ? AND p.status <> 'Bị hủy'
    `, [reviewerId]);

    const [[withdrawn]] = await conn.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_withdrawn 
      FROM payouts WHERE reviewer_id = ? AND status = 'Thành công'
    `, [reviewerId]);

    const availableBalance = earnings.total_income - withdrawn.total_withdrawn;

    if (amount > availableBalance) {
      return res.status(400).json({ error: `Số dư khả dụng không đủ! Bạn chỉ có thể rút tối đa ${availableBalance.toLocaleString('vi-VN')} đ.` });
    }

    // 3. Tạo yêu cầu rút tiền với trạng thái 'Thành công' ngay lập tức
    const id = await nextId(conn, 'payouts', 'PAY');
    await conn.query(
      `INSERT INTO payouts (id, reviewer_id, amount, bank_info, status, process_time) VALUES (?, ?, ?, ?, 'Thành công', NOW())`,
      [id, reviewerId, amount, rev.bank_account]
    );

    await conn.commit();
    res.json({ ok: true, message: 'Rút tiền thành công! Tiền đã được chuyển về tài khoản của bạn.' });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: friendly(err) });
  } finally {
    conn.release();
  }
});

// API cập nhật thông tin ngân hàng cho Reviewer
app.put('/api/reviewers/:id', async (req, res) => {
  const { bankAccount } = req.body;
  const reviewerId = req.params.id;
  try {
    const [result] = await db.query(
      `UPDATE reviewers SET bank_account = ? WHERE id = ?`,
      [bankAccount, reviewerId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Không tìm thấy Reviewer!' });
    }

    res.json({ ok: true, message: 'Cập nhật tài khoản ngân hàng thành công!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API Thêm sản phẩm mẫu mới cho Nhãn hàng (Brand)
app.post('/api/sample-products', async (req, res) => {
  const { brandId, name, price, stock, usageGuide } = req.body;
  const conn = await db.getConnection();
  try {
    // Tạo mã ID tự động cho sản phẩm (VD: SMP005)
    const id = await nextId(conn, 'sample_products', 'SMP');
    
    await conn.query(
      `INSERT INTO sample_products (id, brand_id, name, price, stock, usage_guide) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, brandId, name, price, stock || 0, usageGuide || '']
    );

    res.json({ ok: true, id, message: 'Thêm sản phẩm mẫu thành công!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    conn.release();
  }
});

app.listen(8080, () => console.log('API REVLINK chạy ở http://localhost:8080'));
 