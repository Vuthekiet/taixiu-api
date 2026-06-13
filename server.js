const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const app = express();
const port = process.env.PORT || 3000;

// ==========================================
// KẾT NỐI MONGODB
// ==========================================
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB kết nối thành công!'))
  .catch(err => console.error('❌ Lỗi kết nối DB:', err));

// ==========================================
// SCHEMA
// ==========================================
const historySchema = new mongoose.Schema({
    phien:         { type: Number, required: true, unique: true },
    ketQua:        { type: String, default: null },   // "Tài" / "Xỉu"
    tong:          { type: Number, default: null },
    dices:         [Number],
    duDoan:        { type: String, default: null },   // dự đoán cho phiên này
    cauPhatHien:   { type: String, default: null },   // loại cầu dùng để dự đoán
    dungSai:       { type: String, default: null },   // "Đúng" / "Sai" / "Bỏ"
    timestamp:     { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

app.use(cors());

// ==========================================
// CORE: PHÂN TÍCH CẦU
// ==========================================

/**
 * Lấy chuỗi kết quả gần nhất dạng mảng ["Tài","Xỉu",...]
 * phần tử [0] = phiên gần nhất
 */
async function getRecentResults(limit = 30) {
    const rows = await History.find({ ketQua: { $ne: null } })
        .sort({ phien: -1 })
        .limit(limit)
        .lean();
    return rows.map(r => r.ketQua); // ["Tài","Tài","Xỉu",...]
}

/**
 * 1. CẦU STREAK (bệt liên tiếp)
 *    Nếu N phiên liên tiếp cùng loại → dự đoán tiếp tục
 *    Ví dụ: T T T T → T (cầu bệt 4)
 *    Ngưỡng min: 3 phiên liên tiếp mới tính là cầu
 */
function detectStreakCau(results) {
    if (results.length < 3) return null;
    
    const cur = results[0];
    let streak = 1;
    for (let i = 1; i < results.length; i++) {
        if (results[i] === cur) streak++;
        else break;
    }
    
    if (streak >= 3) {
        return {
            type: `Cầu bệt ${streak} (${cur})`,
            duDoan: cur,
            doTin: Math.min(50 + streak * 5, 75), // cap 75%
            streak
        };
    }
    return null;
}

/**
 * 2. CẦU 1-1 (luân phiên T-X-T-X)
 *    Phát hiện nếu 4+ phiên gần liên tục đổi chiều
 *    Dự đoán: nghịch đảo phiên vừa ra
 */
function detect11Cau(results) {
    if (results.length < 4) return null;
    
    // Kiểm tra 4 phiên gần nhất có phải 1-1 không
    let isAlt = true;
    for (let i = 0; i < 4; i++) {
        if (results[i] === results[i + 1]) { isAlt = false; break; }
    }
    
    if (!isAlt) return null;
    
    // Đếm độ dài cầu 1-1
    let len = 2;
    for (let i = 1; i < results.length - 1; i++) {
        if (results[i] !== results[i + 1]) len++;
        else break;
    }
    
    const next = results[0] === "Tài" ? "Xỉu" : "Tài";
    return {
        type: `Cầu 1-1 (dài ${len})`,
        duDoan: next,
        doTin: Math.min(55 + len * 3, 72),
        streak: len
    };
}

/**
 * 3. CẦU 2-2 (TT-XX-TT-XX)
 *    Kiểm tra pattern 2 phiên cùng loại rồi đổi
 */
function detect22Cau(results) {
    if (results.length < 6) return null;
    
    // Kiểm tra: [0][1] same, [2][3] same, [4][5] same, [0]!=[2], [2]!=[4]
    const ok = results[0] === results[1]
        && results[2] === results[3]
        && results[4] === results[5]
        && results[0] !== results[2]
        && results[2] !== results[4];
    
    if (!ok) return null;
    
    // Đã dùng 2 phiên của nhóm hiện tại → tiếp tục giữ
    // Hoặc vừa đổi nhóm → theo nhóm mới
    const next = results[0]; // tiếp tục nhóm hiện tại (đã có 2 rồi sẽ đổi)
    // Thực ra: nếu [0]==[1] thì nhóm này đủ 2 → phiên tiếp PHẢI đổi
    const predict = results[0] === "Tài" ? "Xỉu" : "Tài";
    
    return {
        type: `Cầu 2-2`,
        duDoan: predict,
        doTin: 65,
        streak: 6
    };
}

/**
 * 4. CẦU 3-3 (TTT-XXX-TTT)
 */
function detect33Cau(results) {
    if (results.length < 6) return null;
    
    const ok = results[0] === results[1]
        && results[1] === results[2]
        && results[3] === results[4]
        && results[4] === results[5]
        && results[0] !== results[3];
    
    if (!ok) return null;
    
    // [0][1][2] cùng loại → đủ 3 → phiên tiếp đổi
    const predict = results[0] === "Tài" ? "Xỉu" : "Tài";
    return {
        type: `Cầu 3-3`,
        duDoan: predict,
        doTin: 68,
        streak: 6
    };
}

/**
 * 5. CẦU THEO TẦN SUẤT
 *    Nếu 15 phiên gần nhất lệch mạnh (ví dụ 11T/4X) → theo chiều ít hơn
 *    (mean reversion - nhưng chỉ dùng khi không có cầu rõ)
 */
function detectFreqCau(results) {
    const sample = results.slice(0, 15);
    if (sample.length < 10) return null;
    
    const tai = sample.filter(r => r === "Tài").length;
    const xiu = sample.length - tai;
    const ratio = tai / sample.length;
    
    if (ratio >= 0.7) {
        return {
            type: `Tần suất lệch (${tai}T/${xiu}X/15 phiên)`,
            duDoan: "Xỉu",
            doTin: 55,
            streak: 0
        };
    } else if (ratio <= 0.3) {
        return {
            type: `Tần suất lệch (${tai}T/${xiu}X/15 phiên)`,
            duDoan: "Tài",
            doTin: 55,
            streak: 0
        };
    }
    return null;
}

/**
 * MASTER: Chạy tất cả detector, ưu tiên theo độ tin cậy
 * Nếu không có cầu rõ → "Bỏ"
 */
function analyzeCau(results) {
    const detectors = [
        detect33Cau,   // ưu tiên cao nhất (pattern rõ)
        detect22Cau,
        detectStreakCau,
        detect11Cau,
        detectFreqCau, // fallback yếu nhất
    ];
    
    for (const fn of detectors) {
        const result = fn(results);
        if (result) return result;
    }
    
    return {
        type: "Không có cầu rõ",
        duDoan: "Bỏ",
        doTin: 0,
        streak: 0
    };
}

// ==========================================
// THỐNG KÊ WINRATE THỰC
// ==========================================
async function getStats(limit = 50) {
    const rows = await History.find({
        ketQua: { $ne: null },
        duDoan: { $ne: null }
    })
    .sort({ phien: -1 })
    .limit(limit)
    .lean();
    
    let total = 0, dung = 0, bo = 0;
    let streak = 0, maxStreak = 0, curStreak = 0;
    
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (r.duDoan === "Bỏ") { bo++; continue; }
        total++;
        if (r.ketQua === r.duDoan) {
            dung++;
            curStreak++;
            maxStreak = Math.max(maxStreak, curStreak);
        } else {
            curStreak = 0;
        }
    }
    
    // Streak sai gần nhất (dùng để cảnh báo)
    let streakSaiGanNhat = 0;
    for (const r of rows) {
        if (r.duDoan === "Bỏ") continue;
        if (r.ketQua !== r.duDoan) streakSaiGanNhat++;
        else break;
    }
    
    // Phân tích loại cầu nào hiệu quả nhất
    const cauStats = {};
    for (const r of rows) {
        if (!r.cauPhatHien || r.duDoan === "Bỏ") continue;
        if (!cauStats[r.cauPhatHien]) cauStats[r.cauPhatHien] = { dung: 0, total: 0 };
        cauStats[r.cauPhatHien].total++;
        if (r.ketQua === r.duDoan) cauStats[r.cauPhatHien].dung++;
    }
    
    return {
        tongPhienBoQua: bo,
        tongPhienDuDoan: total,
        tongPhienDung: dung,
        winrate: total > 0 ? ((dung / total) * 100).toFixed(1) : "0.0",
        streakSaiGanNhat,
        maxStreak,
        cauStats
    };
}

// ==========================================
// API ENDPOINT CHÍNH
// ==========================================
app.get('/api/taixiu', async (req, res) => {
    try {
        const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
        const response = await fetch(apiUrl);
        if (!response.ok) return res.status(response.status).json({ error: "Lỗi API gốc" });
        
        const data = await response.json();
        if (!data?.list || data.list.length < 5) return res.status(500).json({ error: "Thiếu data" });

        // --- Phiên vừa kết thúc ---
        const latest = data.list[0];
        const phienVuaRa = latest.id;
        const dices = latest.dices;
        const tong = dices[0] + dices[1] + dices[2];
        const ketQua = tong >= 11 ? "Tài" : "Xỉu";

        // --- Cập nhật kết quả vào DB ---
        const prevDoc = await History.findOne({ phien: phienVuaRa });
        let dungSai = null;
        if (prevDoc?.duDoan && prevDoc.duDoan !== "Bỏ") {
            dungSai = prevDoc.duDoan === ketQua ? "Đúng" : "Sai";
        } else if (prevDoc?.duDoan === "Bỏ") {
            dungSai = "Bỏ";
        }

        await History.updateOne(
            { phien: phienVuaRa },
            { ketQua, tong, dices, dungSai },
            { upsert: true }
        );

        // --- Lấy lịch sử để phân tích cầu ---
        // Lấy thêm một phiên để đảm bảo đủ dữ liệu sau khi upsert
        const recentResults = await getRecentResults(30);

        // --- Phân tích cầu ---
        const cauResult = analyzeCau(recentResults);

        const phienMoi = phienVuaRa + 1;

        // --- Lưu dự đoán phiên mới ---
        await History.updateOne(
            { phien: phienMoi },
            {
                duDoan: cauResult.duDoan,
                cauPhatHien: cauResult.type
            },
            { upsert: true }
        );

        // --- Lấy thống kê ---
        const stats = await getStats(50);

        // --- Cảnh báo ---
        let canhBao = null;
        if (stats.streakSaiGanNhat >= 3) {
            canhBao = `⛔ ĐANG DÂY ĐEN ${stats.streakSaiGanNhat} phiên liên tiếp sai — KHUYÊN BỎ GAME!`;
        }

        // --- Lịch sử 10 phiên gần ---
        const lichSu10 = await History.find({ ketQua: { $ne: null } })
            .sort({ phien: -1 })
            .limit(10)
            .lean()
            .then(rows => rows.map(r => ({
                phien: r.phien,
                ketQua: r.ketQua,
                tong: r.tong,
                duDoan: r.duDoan || "-",
                dungSai: r.dungSai || "-"
            })));

        res.json({
            // Phiên vừa ra
            Phien_vua_ra: phienVuaRa,
            Ket_qua_vua_ra: ketQua,
            Tong_xuc_xac: tong,
            Dices: dices,

            // Dự đoán phiên tiếp
            Phien_du_doan: phienMoi,
            Cau_phat_hien: cauResult.type,
            Do_tin_cay: `${cauResult.doTin}%`,
            DU_DOAN: cauResult.duDoan,

            // Thống kê
            Thong_ke: {
                Tong_phien_du_doan: stats.tongPhienDuDoan,
                Tong_phien_dung: stats.tongPhienDung,
                Tong_phien_bo: stats.tongPhienBoQua,
                Winrate_thuc: `${stats.winrate}%`,
                Streak_sai_gan_nhat: stats.streakSaiGanNhat,
                Max_streak_dung: stats.maxStreak,
            },

            Canh_bao: canhBao,
            Lich_su_10_phien: lichSu10,
        });

    } catch (err) {
        console.error("Lỗi:", err);
        res.status(500).json({ error: "Lỗi hệ thống: " + err.message });
    }
});

// API lấy lịch sử đầy đủ
app.get('/api/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const rows = await History.find({ ketQua: { $ne: null } })
            .sort({ phien: -1 })
            .limit(limit)
            .lean();
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`🚀 Server v3 chạy tại port ${port}`));
