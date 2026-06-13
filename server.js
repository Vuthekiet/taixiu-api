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
    timestamp:     { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

app.use(cors());
app.use(express.json());

// ==========================================
// PHÂN TÍCH HASH - THUẬT TOÁN CHÍNH
// ==========================================

class HashAnalyzer {
    /**
     * Phân tích cấu trúc hash
     * Hash format: 24 ký tự hex (MongoDB ObjectId style)
     * Timestamp(8) + Machine(6) + Process(4) + Counter(6)
     */
    static analyzeStructure(hashId) {
        if (!hashId || hashId.length !== 24) return null;
        return {
            full: hashId,
            timestamp: hashId.substring(0, 8),
            machine: hashId.substring(8, 14),
            process: hashId.substring(14, 18),
            counter: hashId.substring(18, 24),
            // Các byte quan trọng cho dự đoán
            byte3: parseInt(hashId.substring(18, 20), 16), // Counter byte 1
            byte4: parseInt(hashId.substring(20, 22), 16), // Counter byte 2
            byte5: parseInt(hashId.substring(22, 24), 16), // Counter byte 3 (QUAN TRỌNG NHẤT)
            last2Chars: hashId.substring(22, 24),
            last3Chars: hashId.substring(21, 24),
        };
    }

    /**
     * Dự đoán từ 1 hash đơn
     * Quy luật phát hiện: byte cuối quyết định kết quả
     */
    static predictFromSingle(hashId) {
        const structure = this.analyzeStructure(hashId);
        if (!structure) return null;

        const { byte3, byte4, byte5 } = structure;
        
        // TÍNH TOÁN CÁC CHỈ SỐ
        const sumBytes = byte3 + byte4 + byte5;
        const xorBytes = byte3 ^ byte4 ^ byte5;
        const avgBytes = sumBytes / 3;
        const maxByte = Math.max(byte3, byte4, byte5);
        const minByte = Math.min(byte3, byte4, byte5);
        const range = maxByte - minByte;
        
        // CÔNG THỨC DỰ ĐOÁN CHÍNH
        let prediction = null;
        let confidence = 0;
        let reason = "";
        
        // Pattern 1: Byte5 extreme (< 30 hoặc > 220) -> XIU
        if (byte5 < 30 || byte5 > 220) {
            prediction = "Xỉu";
            confidence = 80;
            reason = `Byte5 extreme: ${byte5}`;
        }
        // Pattern 2: Byte5 trong khoảng 100-180 -> TAI
        else if (byte5 >= 100 && byte5 <= 180) {
            prediction = "Tài";
            confidence = 75;
            reason = `Byte5 mid-range: ${byte5}`;
        }
        // Pattern 3: Tổng 3 byte chẵn và byte5 lẻ -> TAI
        else if (sumBytes % 2 === 0 && byte5 % 2 === 1) {
            prediction = "Tài";
            confidence = 70;
            reason = `Sum chẵn & Byte5 lẻ`;
        }
        // Pattern 4: XOR < 100 -> TAI
        else if (xorBytes < 100) {
            prediction = "Tài";
            confidence = 65;
            reason = `XOR thấp: ${xorBytes}`;
        }
        // Pattern 5: Range > 150 -> XIU
        else if (range > 150) {
            prediction = "Xỉu";
            confidence = 60;
            reason = `Range lớn: ${range}`;
        }
        // Pattern 6: Trung bình > 150 -> TAI
        else if (avgBytes > 150) {
            prediction = "Tài";
            confidence = 55;
            reason = `Avg cao: ${avgBytes.toFixed(1)}`;
        }
        // Default
        else {
            prediction = byte5 % 2 === 0 ? "Tài" : "Xỉu";
            confidence = 50;
            reason = `Default parity`;
        }

        return {
            prediction,
            confidence,
            reason,
            details: {
                byte3, byte4, byte5,
                sumBytes, xorBytes, avgBytes: Math.round(avgBytes),
                range, maxByte, minByte
            }
        };
    }

    /**
     * Dự đoán từ cặp hash (CHÍNH XÁC HƠN)
     * So sánh sự thay đổi giữa 2 hash liên tiếp
     */
    static predictFromPair(prevHash, currHash) {
        const prev = this.analyzeStructure(prevHash);
        const curr = this.analyzeStructure(currHash);
        
        if (!prev || !curr) return null;

        // Sự thay đổi các byte
        const diff3 = curr.byte3 - prev.byte3;
        const diff4 = curr.byte4 - prev.byte4;
        const diff5 = curr.byte5 - prev.byte5; // QUAN TRỌNG NHẤT
        const sumDiff = (curr.byte3 + curr.byte4 + curr.byte5) - 
                       (prev.byte3 + prev.byte4 + prev.byte5);
        
        // Phân tích đơn lẻ
        const prevAnalysis = this.predictFromSingle(prevHash);
        const currAnalysis = this.predictFromSingle(currHash);
        
        let prediction = null;
        let confidence = 0;
        let reason = "";
        
        // CÔNG THỨC DỰ ĐOÁN TỪ CẶP
        // Pattern A: diff5 giảm mạnh (< -40) -> XIU
        if (diff5 < -40) {
            prediction = "Xỉu";
            confidence = 85;
            reason = `Byte5 giảm mạnh: ${diff5}`;
        }
        // Pattern B: diff5 tăng mạnh (> 40) -> TAI
        else if (diff5 > 40) {
            prediction = "Tài";
            confidence = 85;
            reason = `Byte5 tăng mạnh: ${diff5}`;
        }
        // Pattern C: diff5 trong khoảng 10-40 -> TAI
        else if (diff5 > 10 && diff5 <= 40) {
            prediction = "Tài";
            confidence = 75;
            reason = `Byte5 tăng vừa: ${diff5}`;
        }
        // Pattern D: diff5 trong khoảng -40 đến -10 -> XIU
        else if (diff5 < -10 && diff5 >= -40) {
            prediction = "Xỉu";
            confidence = 75;
            reason = `Byte5 giảm vừa: ${diff5}`;
        }
        // Pattern E: diff5 gần 0 (±10) -> Đảo chiều
        else if (Math.abs(diff5) <= 10) {
            prediction = prevAnalysis.prediction === "Tài" ? "Xỉu" : "Tài";
            confidence = 70;
            reason = `Byte5 ổn định, đảo chiều`;
        }
        // Pattern F: Dựa vào sumDiff
        else if (sumDiff > 50) {
            prediction = "Tài";
            confidence = 65;
            reason = `Tổng tăng: ${sumDiff}`;
        }
        else if (sumDiff < -50) {
            prediction = "Xỉu";
            confidence = 65;
            reason = `Tổng giảm: ${sumDiff}`;
        }
        // Fallback
        else {
            prediction = currAnalysis.prediction;
            confidence = currAnalysis.confidence - 5;
            reason = `Fallback: ${currAnalysis.reason}`;
        }

        return {
            prediction,
            confidence,
            reason,
            prev: prevAnalysis,
            curr: currAnalysis,
            diffs: { diff3, diff4, diff5, sumDiff }
        };
    }

    /**
     * Học từ lịch sử để cải thiện dự đoán
     */
    static async learnFromHistory(limit = 50) {
        const history = await History.find({
            hashId: { $ne: null },
            ketQua: { $ne: null }
        })
        .sort({ phien: -1 })
        .limit(limit)
        .lean();

        if (history.length < 10) return { patterns: {}, totalSamples: 0 };

        const patterns = {};
        let correctPredictions = 0;
        let totalPredictions = 0;

        // Phân tích từng cặp
        for (let i = 0; i < history.length - 1; i++) {
            const curr = history[i];
            const prev = history[i + 1];
            
            if (!curr.hashId || !prev.hashId) continue;

            const analysis = this.predictFromPair(prev.hashId, curr.hashId);
            if (!analysis) continue;

            // Tạo key cho pattern
            const diff5Range = analysis.diffs.diff5;
            let rangeKey;
            if (diff5 < -40) rangeKey = "giảm_mạnh";
            else if (diff5 < -10) rangeKey = "giảm_vừa";
            else if (diff5 <= 10) rangeKey = "ổn_định";
            else if (diff5 <= 40) rangeKey = "tăng_vừa";
            else rangeKey = "tăng_mạnh";

            if (!patterns[rangeKey]) {
                patterns[rangeKey] = {
                    total: 0,
                    correct: 0,
                    predictedTai: 0,
                    predictedXiu: 0,
                    actualTai: 0,
                    actualXiu: 0
                };
            }

            patterns[rangeKey].total++;
            totalPredictions++;
            
            if (analysis.prediction === curr.ketQua) {
                patterns[rangeKey].correct++;
                correctPredictions++;
            }

            if (analysis.prediction === "Tài") patterns[rangeKey].predictedTai++;
            else patterns[rangeKey].predictedXiu++;
            
            if (curr.ketQua === "Tài") patterns[rangeKey].actualTai++;
            else patterns[rangeKey].actualXiu++;
        }

        // Tính tỉ lệ cho từng pattern
        Object.keys(patterns).forEach(key => {
            patterns[key].accuracy = patterns[key].total > 0 
                ? ((patterns[key].correct / patterns[key].total) * 100).toFixed(1) 
                : 0;
            patterns[key].weight = patterns[key].accuracy / 100;
        });

        return {
            patterns,
            totalSamples: totalPredictions,
            overallAccuracy: totalPredictions > 0 
                ? ((correctPredictions / totalPredictions) * 100).toFixed(1) 
                : 0,
            correctPredictions,
            totalPredictions
        };
    }
}

// ==========================================
// PHÂN TÍCH CẦU (GIỮ NGUYÊN + CẢI TIẾN)
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
    
    const ok = results[0] === results[1]
        && results[2] === results[3]
        && results[4] === results[5]
        && results[0] !== results[2]
        && results[2] !== results[4];
    
    if (!ok) return null;
    
    const predict = results[0] === "Tài" ? "Xỉu" : "Tài";
    return {
        type: `Cầu 2-2`,
        duDoan: predict,
        doTin: 65,
        streak: 6
    };
}

function detect33Cau(results) {
    if (results.length < 6) return null;
    
    const ok = results[0] === results[1]
        && results[1] === results[2]
        && results[3] === results[4]
        && results[4] === results[5]
        && results[0] !== results[3];
    
    if (!ok) return null;
    
    const predict = results[0] === "Tài" ? "Xỉu" : "Tài";
    return {
        type: `Cầu 3-3`,
        duDoan: predict,
        doTin: 68,
        streak: 6
    };
}

function detectFreqCau(results) {
    const sample = results.slice(0, 15);
    if (sample.length < 10) return null;
    
    const tai = sample.filter(r => r === "Tài").length;
    const xiu = sample.length - tai;
    const ratio = tai / sample.length;
    
    if (ratio >= 0.7) {
        return {
            type: `Tần suất lệch (${tai}T/${xiu}X)`,
            duDoan: "Xỉu",
            doTin: 55,
            streak: 0
        };
    } else if (ratio <= 0.3) {
        return {
            type: `Tần suất lệch (${tai}T/${xiu}X)`,
            duDoan: "Tài",
            doTin: 55,
            streak: 0
        };
    }
    return null;
}

function analyzeCau(results) {
    const detectors = [
        detect33Cau,
        detect22Cau,
        detectStreakCau,
        detect11Cau,
        detectFreqCau,
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
// MASTER ANALYZER - KẾT HỢP TẤT CẢ
// ==========================================

async function masterPredict(prevHash, currHash, recentResults) {
    // 1. Phân tích hash
    const hashPrediction = prevHash && currHash 
        ? HashAnalyzer.predictFromPair(prevHash, currHash)
        : null;
    
    // 2. Phân tích cầu
    const cauPrediction = analyzeCau(recentResults);
    
    // 3. Học từ lịch sử
    const learnedPatterns = await HashAnalyzer.learnFromHistory(30);
    
    // 4. Kết hợp dự đoán
    let finalPrediction = null;
    let finalType = "";
    let finalConfidence = 0;
    
    // Nếu hash prediction có confidence cao (>70) -> ưu tiên hash
    if (hashPrediction && hashPrediction.confidence >= 70) {
        finalPrediction = hashPrediction.prediction;
        finalConfidence = hashPrediction.confidence;
        finalType = `Hash: ${hashPrediction.reason}`;
        
        // Tăng confidence nếu khớp với cầu
        if (cauPrediction.duDoan === hashPrediction.prediction && cauPrediction.doTin > 0) {
            finalConfidence = Math.min(finalConfidence + 10, 95);
            finalType += ` + ${cauPrediction.type}`;
        }
    }
    // Nếu hash có confidence trung bình (50-70) -> kết hợp với cầu
    else if (hashPrediction && hashPrediction.confidence >= 50) {
        if (cauPrediction.duDoan === hashPrediction.prediction) {
            // Hash và cầu cùng ý -> tăng confidence
            finalPrediction = hashPrediction.prediction;
            finalConfidence = Math.max(hashPrediction.confidence, cauPrediction.doTin) + 5;
            finalType = `Kết hợp: ${hashPrediction.reason} + ${cauPrediction.type}`;
        } else if (cauPrediction.doTin >= 65) {
            // Cầu mạnh hơn -> theo cầu
            finalPrediction = cauPrediction.duDoan;
            finalConfidence = cauPrediction.doTin;
            finalType = `Cầu (ghi đè hash): ${cauPrediction.type}`;
        } else {
            // Hash yếu và cầu yếu -> theo hash
            finalPrediction = hashPrediction.prediction;
            finalConfidence = hashPrediction.confidence;
            finalType = `Hash (yếu): ${hashPrediction.reason}`;
        }
    }
    // Nếu không có hash -> dùng cầu
    else if (cauPrediction.doTin > 0) {
        finalPrediction = cauPrediction.duDoan;
        finalConfidence = cauPrediction.doTin;
        finalType = `Cầu: ${cauPrediction.type}`;
    }
    // Không có gì -> bỏ
    else {
        finalPrediction = "Bỏ";
        finalConfidence = 0;
        finalType = "Không đủ dữ liệu";
    }
    
    // 5. Áp dụng học từ lịch sử
    if (hashPrediction && learnedPatterns.patterns) {
        const diff5 = hashPrediction.diffs?.diff5;
        let rangeKey;
        if (diff5 < -40) rangeKey = "giảm_mạnh";
        else if (diff5 < -10) rangeKey = "giảm_vừa";
        else if (diff5 <= 10) rangeKey = "ổn_định";
        else if (diff5 <= 40) rangeKey = "tăng_vừa";
        else rangeKey = "tăng_mạnh";
        
        const pattern = learnedPatterns.patterns[rangeKey];
        
        // Nếu pattern có accuracy < 40% -> đảo ngược dự đoán
        if (pattern && pattern.total >= 5 && parseFloat(pattern.accuracy) < 40) {
            const reversedPrediction = finalPrediction === "Tài" ? "Xỉu" : 
                                       finalPrediction === "Xỉu" ? "Tài" : "Bỏ";
            if (reversedPrediction !== "Bỏ") {
                finalPrediction = reversedPrediction;
                finalConfidence = Math.max(finalConfidence - 15, 50);
                finalType = `Đảo ngược (pattern yếu ${pattern.accuracy}%): ${finalType}`;
            }
        }
    }
    
    return {
        duDoan: finalPrediction,
        doTin: Math.round(finalConfidence),
        type: finalType,
        hashAnalysis: hashPrediction,
        cauAnalysis: cauPrediction,
        learnedPatterns: learnedPatterns.patterns ? 
            Object.keys(learnedPatterns.patterns).map(k => ({
                pattern: k,
                accuracy: learnedPatterns.patterns[k].accuracy + '%',
                samples: learnedPatterns.patterns[k].total
            })) : []
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

        // --- Cập nhật kết quả vào DB ---
        const prevDoc = await History.findOne({ phien: phienVuaRa });
        let dungSai = null;
        if (prevDoc?.duDoan && prevDoc.duDoan !== "Bỏ") {
            dungSai = prevDoc.duDoan === ketQua ? "Đúng" : "Sai";
        } else if (prevDoc?.duDoan === "Bỏ") {
            dungSai = "Bỏ";
        }

        // Lưu thêm hash analysis
        const hashStructure = HashAnalyzer.analyzeStructure(currHash);
        
        await History.updateOne(
            { phien: phienVuaRa },
            { 
                ketQua, 
                tong, 
                dices, 
                dungSai,
                hashId: currHash,
                hashAnalysis: hashStructure
            },
            { upsert: true }
        );

        // --- Lấy lịch sử để phân tích ---
        const recentResults = await getRecentResults(30);

        // --- MASTER PREDICT ---
        const prediction = await masterPredict(prevHash, currHash, recentResults);

        const phienMoi = phienVuaRa + 1;

        // --- Lưu dự đoán phiên mới ---
        await History.updateOne(
            { phien: phienMoi },
            {
                duDoan: prediction.duDoan,
                cauPhatHien: prediction.type
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
                dungSai: r.dungSai || "-",
                hashId: r.hashId ? r.hashId.substring(22, 24) : "-"
            })));

        res.json({
            // Phiên vừa ra
            Phien_vua_ra: phienVuaRa,
            Ket_qua_vua_ra: ketQua,
            Tong_xuc_xac: tong,
            Dices: dices,
            Hash_hien_tai: currHash,
            Hash_byte_cuoi: hashStructure ? hashStructure.last2Chars : null,

            // Dự đoán phiên tiếp
            Phien_du_doan: phienMoi,
            Cau_phat_hien: prediction.type,
            Do_tin_cay: `${prediction.doTin}%`,
            DU_DOAN: prediction.duDoan,

            // Chi tiết phân tích
            Chi_tiet_phan_tich: {
                Hash: prediction.hashAnalysis ? {
                    du_doan: prediction.hashAnalysis.prediction,
                    do_tin_cay: `${prediction.hashAnalysis.confidence}%`,
                    ly_do: prediction.hashAnalysis.reason,
                    chi_tiet_byte: prediction.hashAnalysis.curr?.details,
                    thay_doi: prediction.hashAnalysis.diffs
                } : null,
                Cau: prediction.cauAnalysis,
                Hoc_may: prediction.learnedPatterns
            },

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

// API phân tích hash
app.get('/api/analyze-hash', (req, res) => {
    const { hash, prevHash } = req.query;
    
    if (!hash) return res.status(400).json({ error: "Thiếu hash" });
    
    const singleAnalysis = HashAnalyzer.predictFromSingle(hash);
    let pairAnalysis = null;
    
    if (prevHash) {
        pairAnalysis = HashAnalyzer.predictFromPair(prevHash, hash);
    }
    
    res.json({
        hash,
        structure: HashAnalyzer.analyzeStructure(hash),
        single_analysis: singleAnalysis,
        pair_analysis: pairAnalysis
    });
});

// API học từ lịch sử
app.get('/api/learn-patterns', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const learned = await HashAnalyzer.learnFromHistory(limit);
        res.json(learned);
    } catch (err) {
        res.status(500).json({ error: err.message });
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

// API xóa lịch sử (nếu cần test lại)
app.delete('/api/history', async (req, res) => {
    try {
        await History.deleteMany({});
        res.json({ success: true, message: "Đã xóa toàn bộ lịch sử" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(port, () => console.log(`🚀 Server v4 chạy tại port ${port} - Tích hợp phân tích Hash`));
