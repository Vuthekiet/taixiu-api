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
    ketQua:        { type: String, default: null },
    tong:          { type: Number, default: null },
    dices:         [Number],
    duDoan:        { type: String, default: null },
    cauPhatHien:   { type: String, default: null },
    dungSai:       { type: String, default: null },
    hashId:        { type: String, default: null },
    hashAnalysis:  { type: Object, default: null },
    hashOriginalPrediction: { type: String, default: null }, // Dự đoán gốc từ hash
    timestamp:     { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

app.use(cors());
app.use(express.json());

// ==========================================
// BIẾN TOÀN CỤC THEO DÕI HIỆU SUẤT HASH
// ==========================================
let hashPerformance = {
    total: 0,
    correct: 0,
    recentCorrect: 0,
    recentTotal: 0,
    shouldInvert: false,
    lastChecked: Date.now()
};

// ==========================================
// PHÂN TÍCH HASH CƠ BẢN
// ==========================================
class HashAnalyzer {
    static analyzeStructure(hashId) {
        if (!hashId || hashId.length !== 24) return null;
        return {
            full: hashId,
            timestamp: hashId.substring(0, 8),
            machine: hashId.substring(8, 14),
            process: hashId.substring(14, 18),
            counter: hashId.substring(18, 24),
            byte3: parseInt(hashId.substring(18, 20), 16),
            byte4: parseInt(hashId.substring(20, 22), 16),
            byte5: parseInt(hashId.substring(22, 24), 16),
            last2Chars: hashId.substring(22, 24),
        };
    }

    static simplePredict(hashId) {
        const s = this.analyzeStructure(hashId);
        if (!s) return null;
        // Dự đoán dựa trên parity của byte5 (chẵn -> Tài, lẻ -> Xỉu)
        const prediction = s.byte5 % 2 === 0 ? "Tài" : "Xỉu";
        return {
            prediction,
            confidence: 50,
            reason: `Byte5 parity: ${s.byte5} (${s.byte5 % 2 === 0 ? 'chẵn' : 'lẻ'})`
        };
    }
}

// ==========================================
// CẬP NHẬT HIỆU SUẤT HASH (TỰ HỌC)
// ==========================================
async function updateHashPerformance() {
    const recent = await History.find({
        hashOriginalPrediction: { $ne: null },
        ketQua: { $ne: null },
        duDoan: { $ne: null }
    })
    .sort({ phien: -1 })
    .limit(20)
    .lean();

    let correct = 0;
    let total = 0;
    for (const r of recent) {
        if (r.duDoan === "Bỏ") continue;
        total++;
        if (r.hashOriginalPrediction === r.ketQua) correct++;
    }

    console.log(`[HASH PERFORMANCE] Đúng: ${correct}/${total} phiên gần đây`);
    
    if (total >= 3) { // Chỉ cần 3 phiên để đánh giá
        const accuracy = correct / total;
        hashPerformance.shouldInvert = (accuracy < 0.5);
        hashPerformance.recentCorrect = correct;
        hashPerformance.recentTotal = total;
        console.log(`[HASH PERFORMANCE] Accuracy: ${(accuracy*100).toFixed(1)}%, Đảo ngược: ${hashPerformance.shouldInvert}`);
    } else {
        console.log(`[HASH PERFORMANCE] Chưa đủ mẫu (${total}/3)`);
    }
    hashPerformance.lastChecked = Date.now();
}

// ==========================================
// DỰ ĐOÁN HASH CÓ TỰ ĐỘNG ĐẢO NGƯỢC
// ==========================================
async function getHashPrediction(currHash, prevHash) {
    if (!currHash) return null;
    
    const base = HashAnalyzer.simplePredict(currHash);
    if (!base) return null;

    let confidence = base.confidence;
    let reason = base.reason;
    
    if (prevHash) {
        const prevS = HashAnalyzer.analyzeStructure(prevHash);
        const currS = HashAnalyzer.analyzeStructure(currHash);
        if (prevS && currS) {
            const diff5 = currS.byte5 - prevS.byte5;
            if (Math.abs(diff5) > 50) confidence += 10;
            reason += ` | diff5: ${diff5}`;
        }
    }

    let finalPrediction = base.prediction;
    if (hashPerformance.shouldInvert) {
        finalPrediction = finalPrediction === "Tài" ? "Xỉu" : "Tài";
        reason = `[ĐẢO NGƯỢC] ${reason}`;
        confidence = Math.max(confidence - 5, 50);
    }

    return {
        prediction: finalPrediction,
        confidence: Math.min(confidence, 80),
        reason,
        originalPrediction: base.prediction
    };
}

// ==========================================
// PHÂN TÍCH CẦU TRUYỀN THỐNG
// ==========================================
async function getRecentResults(limit = 30) {
    const rows = await History.find({ ketQua: { $ne: null } })
        .sort({ phien: -1 })
        .limit(limit)
        .lean();
    return rows.map(r => r.ketQua);
}

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
            doTin: Math.min(50 + streak * 5, 75),
            streak
        };
    }
    return null;
}

function detect11Cau(results) {
    if (results.length < 4) return null;
    let isAlt = true;
    for (let i = 0; i < 4; i++) {
        if (results[i] === results[i + 1]) { isAlt = false; break; }
    }
    if (!isAlt) return null;
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

function detect22Cau(results) {
    if (results.length < 6) return null;
    const ok = results[0] === results[1] && results[2] === results[3] &&
               results[4] === results[5] && results[0] !== results[2] &&
               results[2] !== results[4];
    if (!ok) return null;
    const predict = results[0] === "Tài" ? "Xỉu" : "Tài";
    return { type: `Cầu 2-2`, duDoan: predict, doTin: 65, streak: 6 };
}

function detect33Cau(results) {
    if (results.length < 6) return null;
    const ok = results[0] === results[1] && results[1] === results[2] &&
               results[3] === results[4] && results[4] === results[5] &&
               results[0] !== results[3];
    if (!ok) return null;
    const predict = results[0] === "Tài" ? "Xỉu" : "Tài";
    return { type: `Cầu 3-3`, duDoan: predict, doTin: 68, streak: 6 };
}

function detectFreqCau(results) {
    const sample = results.slice(0, 15);
    if (sample.length < 10) return null;
    const tai = sample.filter(r => r === "Tài").length;
    const xiu = sample.length - tai;
    const ratio = tai / sample.length;
    if (ratio >= 0.7) {
        return { type: `Tần suất lệch (${tai}T/${xiu}X)`, duDoan: "Xỉu", doTin: 55, streak: 0 };
    } else if (ratio <= 0.3) {
        return { type: `Tần suất lệch (${tai}T/${xiu}X)`, duDoan: "Tài", doTin: 55, streak: 0 };
    }
    return null;
}

function analyzeCau(results) {
    const detectors = [detect33Cau, detect22Cau, detectStreakCau, detect11Cau, detectFreqCau];
    for (const fn of detectors) {
        const result = fn(results);
        if (result) return result;
    }
    return { type: "Không có cầu rõ", duDoan: "Bỏ", doTin: 0, streak: 0 };
}

// ==========================================
// MASTER PREDICT (KẾT HỢP HASH + CẦU)
// ==========================================
async function masterPredict(prevHash, currHash, recentResults) {
    const hashPred = await getHashPrediction(currHash, prevHash);
    const cauPred = analyzeCau(recentResults);
    
    let finalDuDoan, finalType, finalDoTin;
    
    if (hashPred && cauPred.duDoan !== "Bỏ" && hashPred.prediction === cauPred.duDoan) {
        finalDuDoan = hashPred.prediction;
        finalDoTin = Math.max(hashPred.confidence, cauPred.doTin) + 5;
        finalType = `Kết hợp: Hash + Cầu (${cauPred.type})`;
    } else if (hashPred && hashPred.confidence >= 65) {
        finalDuDoan = hashPred.prediction;
        finalDoTin = hashPred.confidence;
        finalType = `Hash (ưu tiên): ${hashPred.reason}`;
    } else if (cauPred.duDoan !== "Bỏ" && cauPred.doTin >= 60) {
        finalDuDoan = cauPred.duDoan;
        finalDoTin = cauPred.doTin;
        finalType = `Cầu (ưu tiên): ${cauPred.type}`;
    } else if (hashPred) {
        finalDuDoan = hashPred.prediction;
        finalDoTin = hashPred.confidence;
        finalType = `Hash (yếu): ${hashPred.reason}`;
    } else {
        finalDuDoan = "Bỏ";
        finalDoTin = 0;
        finalType = "Không đủ dữ liệu";
    }

    return {
        duDoan: finalDuDoan,
        doTin: Math.round(finalDoTin),
        type: finalType,
        hashDetails: hashPred,
        cauDetails: cauPred,
        hashInverted: hashPerformance.shouldInvert
    };
}

// ==========================================
// THỐNG KÊ
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
    let maxStreak = 0, curStreak = 0;
    
    for (const r of rows) {
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
    
    let streakSaiGanNhat = 0;
    for (const r of rows) {
        if (r.duDoan === "Bỏ") continue;
        if (r.ketQua !== r.duDoan) streakSaiGanNhat++;
        else break;
    }
    
    return {
        tongPhienBoQua: bo,
        tongPhienDuDoan: total,
        tongPhienDung: dung,
        winrate: total > 0 ? ((dung / total) * 100).toFixed(1) : "0.0",
        streakSaiGanNhat,
        maxStreak
    };
}

// ==========================================
// API ENDPOINTS
// ==========================================

app.get('/api/taixiu', async (req, res) => {
    try {
        const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
        const response = await fetch(apiUrl);
        if (!response.ok) return res.status(response.status).json({ error: "Lỗi API gốc" });
        
        const data = await response.json();
        if (!data?.list || data.list.length < 3) return res.status(500).json({ error: "Thiếu data" });

        // --- Phiên vừa kết thúc ---
        const latest = data.list[0];
        const previous = data.list[1];
        const phienVuaRa = latest.id;
        const dices = latest.dices;
        const tong = dices[0] + dices[1] + dices[2];
        const ketQua = tong >= 11 ? "Tài" : "Xỉu";
        const currHash = latest._id;
        const prevHash = previous._id;

        // --- Cập nhật kết quả phiên vừa ra (KHÔNG ghi đè hashAnalysis) ---
        const prevDoc = await History.findOne({ phien: phienVuaRa });
        let dungSai = null;
        if (prevDoc?.duDoan && prevDoc.duDoan !== "Bỏ") {
            dungSai = prevDoc.duDoan === ketQua ? "Đúng" : "Sai";
        } else if (prevDoc?.duDoan === "Bỏ") {
            dungSai = "Bỏ";
        }

        await History.updateOne(
            { phien: phienVuaRa },
            { $set: { ketQua, tong, dices, dungSai, hashId: currHash } },
            { upsert: true }
        );

        // --- Cập nhật hiệu suất hash ---
        await updateHashPerformance();

        // --- Lấy lịch sử kết quả để phân tích cầu ---
        const recentResults = await getRecentResults(30);

        // --- Dự đoán phiên tiếp theo ---
        const prediction = await masterPredict(prevHash, currHash, recentResults);
        const phienMoi = phienVuaRa + 1;

        // Lưu dự đoán cho phiên mới, bao gồm originalPrediction
        const hashStruct = HashAnalyzer.analyzeStructure(currHash);
        await History.updateOne(
            { phien: phienMoi },
            {
                duDoan: prediction.duDoan,
                cauPhatHien: prediction.type,
                hashId: currHash,
                hashAnalysis: hashStruct,
                hashOriginalPrediction: prediction.hashDetails?.originalPrediction || null
            },
            { upsert: true }
        );

        // --- Thống kê ---
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
                dungSai: r.dungSai || "-",
                byteCuoi: r.hashId ? r.hashId.substring(22, 24) : "-",
                hashOrigPred: r.hashOriginalPrediction || "-"
            })));

        res.json({
            Phien_vua_ra: phienVuaRa,
            Ket_qua_vua_ra: ketQua,
            Tong_xuc_xac: tong,
            Dices: dices,
            Hash_hien_tai: currHash,
            Byte_cuoi: hashStruct?.last2Chars,

            Phien_du_doan: phienMoi,
            Cau_phat_hien: prediction.type,
            Do_tin_cay: `${prediction.doTin}%`,
            DU_DOAN: prediction.duDoan,

            Chi_tiet_phan_tich: {
                Hash: prediction.hashDetails ? {
                    du_doan_goc: prediction.hashDetails.originalPrediction,
                    du_doan_sau_dieu_chinh: prediction.hashDetails.prediction,
                    do_tin_cay: `${prediction.hashDetails.confidence}%`,
                    ly_do: prediction.hashDetails.reason
                } : null,
                Cau: prediction.cauDetails,
                Dang_dao_nguoc_hash: hashPerformance.shouldInvert,
                Hieu_suat_hash: `${hashPerformance.recentCorrect}/${hashPerformance.recentTotal} đúng gần đây`
            },

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

app.delete('/api/history', async (req, res) => {
    try {
        await History.deleteMany({});
        res.json({ success: true, message: "Đã xóa toàn bộ lịch sử" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`🚀 Server v6 chạy tại port ${port} - Tự sửa sai hash đã sửa lỗi`)); 
