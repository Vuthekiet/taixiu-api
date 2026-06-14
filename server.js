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
    hashOriginalPrediction: { type: String, default: null },
    timestamp:     { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

app.use(cors());
app.use(express.json());

// ==========================================
// BIẾN TOÀN CỤC THEO DÕI HIỆU SUẤT
// ==========================================
let performanceStats = {
    total: 0,
    correct: 0,
    shouldInvert: false,
    recentAccuracy: 0
};

// ==========================================
// THUẬT TOÁN DỰ ĐOÁN LOGIC MỚI (DỰA TRÊN HASH & TREND)
// ==========================================
class AdvancedPredictor {
    static analyzeHash(hashId) {
        if (!hashId || hashId.length < 2) return null;
        const lastByte = parseInt(hashId.substring(hashId.length - 2), 16);
        const secondLastByte = parseInt(hashId.substring(hashId.length - 4, hashId.length - 2), 16);
        return {
            lastByte,
            secondLastByte,
            parity: lastByte % 2 === 0 ? "Tài" : "Xỉu",
            sumBytes: (lastByte + secondLastByte) % 2 === 0 ? "Tài" : "Xỉu"
        };
    }

    static async getPrediction(currHash, recentResults, lastSession) {
        const hashInfo = this.analyzeHash(currHash);
        if (!hashInfo) return { prediction: "Bỏ", reason: "Thiếu dữ liệu Hash", confidence: 0 };

        let prediction = hashInfo.parity;
        let reason = `Dựa trên Parity Byte cuối Hash (${hashInfo.lastByte})`;
        let confidence = 65;

        // --- Kiểm tra Cầu (Trend Analysis) ---
        const streak = this.detectStreak(recentResults);
        if (streak && streak.length >= 3) {
            // Nếu đang bệt, ưu tiên theo bệt nếu Hash cũng ủng hộ
            if (streak.type === prediction) {
                confidence += 10;
                reason = `Cầu bệt ${streak.length} + Hash ủng hộ`;
            } else {
                // Nếu Hash ngược với bệt, có thể là cầu gãy hoặc Hash đang chiếm ưu thế
                reason = `Hash (${prediction}) ngược Cầu bệt (${streak.type})`;
                confidence = 60;
            }
        }

        // --- Logic Tự Học (Inversion) ---
        if (performanceStats.shouldInvert) {
            prediction = prediction === "Tài" ? "Xỉu" : "Tài";
            reason = `[ĐẢO NGƯỢC] ${reason}`;
        }

        return {
            prediction,
            reason,
            confidence,
            originalPrediction: hashInfo.parity
        };
    }

    static detectStreak(results) {
        if (!results || results.length < 2) return null;
        const type = results[0];
        let length = 1;
        for (let i = 1; i < results.length; i++) {
            if (results[i] === type) length++;
            else break;
        }
        return { type, length };
    }
}

// ==========================================
// CẬP NHẬT HIỆU SUẤT
// ==========================================
async function updatePerformance() {
    const recent = await History.find({
        duDoan: { $ne: "Bỏ", $ne: null },
        ketQua: { $ne: null }
    }).sort({ phien: -1 }).limit(20).lean();

    if (recent.length >= 5) {
        const correct = recent.filter(r => r.duDoan === r.ketQua).length;
        const accuracy = correct / recent.length;
        performanceStats.recentAccuracy = accuracy;
        performanceStats.shouldInvert = accuracy < 0.45; // Nếu tỉ lệ đúng quá thấp, tự động đảo ngược logic
        console.log(`[PERFORMANCE] Accuracy: ${(accuracy * 100).toFixed(1)}%, Invert: ${performanceStats.shouldInvert}`);
    }
}

// ==========================================
// API ENDPOINTS
// ==========================================

app.get('/api/taixiu', async (req, res) => {
    try {
        const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
        const response = await fetch(apiUrl);
        if (!response.ok) throw new Error("Lỗi API gốc");
        
        const data = await response.json();
        if (!data?.list || data.list.length < 2) throw new Error("Dữ liệu không đủ");

        const latest = data.list[0];
        const phienVuaRa = latest.id;
        const dices = latest.dices;
        const tong = dices.reduce((a, b) => a + b, 0);
        const ketQua = tong >= 11 ? "Tài" : "Xỉu";
        const currHash = latest._id;

        // 1. Cập nhật kết quả phiên vừa ra
        const lastDoc = await History.findOne({ phien: phienVuaRa });
        let dungSai = lastDoc?.duDoan ? (lastDoc.duDoan === ketQua ? "Đúng" : "Sai") : "N/A";
        
        await History.updateOne(
            { phien: phienVuaRa },
            { $set: { ketQua, tong, dices, dungSai, hashId: currHash } },
            { upsert: true }
        );

        // 2. Cập nhật hiệu suất
        await updatePerformance();

        // 3. Dự đoán phiên tiếp theo
        const recentResults = (await History.find({ ketQua: { $ne: null } })
            .sort({ phien: -1 }).limit(30).lean()).map(r => r.ketQua);
        
        const prediction = await AdvancedPredictor.getPrediction(currHash, recentResults, latest);
        const phienMoi = phienVuaRa + 1;

        await History.updateOne(
            { phien: phienMoi },
            {
                duDoan: prediction.prediction,
                cauPhatHien: prediction.reason,
                hashId: currHash,
                hashOriginalPrediction: prediction.originalPrediction
            },
            { upsert: true }
        );

        // 4. Lấy thống kê
        const stats = await getStats(50);

        res.json({
            Phien_vua_ra: phienVuaRa,
            Ket_qua: ketQua,
            Dices: dices,
            Phien_tiep_theo: phienMoi,
            DU_DOAN: prediction.prediction,
            Do_tin_cay: `${prediction.confidence}%`,
            Ly_do: prediction.reason,
            Thong_ke: stats
        });

    } catch (err) {
        console.error("Lỗi:", err);
        res.status(500).json({ error: err.message });
    }
});

async function getStats(limit) {
    const rows = await History.find({ ketQua: { $ne: null }, duDoan: { $ne: "Bỏ" } })
        .sort({ phien: -1 }).limit(limit).lean();
    const correct = rows.filter(r => r.ketQua === r.duDoan).length;
    return {
        total: rows.length,
        correct,
        winrate: rows.length > 0 ? ((correct / rows.length) * 100).toFixed(1) + "%" : "0%"
    };
}

app.get('/api/history', async (req, res) => {
    const rows = await History.find().sort({ phien: -1 }).limit(50).lean();
    res.json(rows);
});

app.listen(port, () => console.log(`🚀 Server v7 - Thuật toán Logic Hash & Trend chạy tại port ${port}`));
