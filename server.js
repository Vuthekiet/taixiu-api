const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const app = express();

const port = process.env.PORT || 3000;

// ==========================================
// THIẾT LẬP KẾT NỐI MONGODB
// ==========================================
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:Kiet280911@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Đã kết nối Cơ sở dữ liệu MongoDB thành công!'))
  .catch(err => console.error('❌ Lỗi kết nối DB:', err));

// ==========================================
// SCHEMA CẢI TIẾN
// ==========================================
const historySchema = new mongoose.Schema({
    phien: { type: Number, required: true, unique: true },
    ketQuaThucTe: { type: String, default: null },
    tong: { type: Number, default: null },
    dices: [Number],
    duDoanForm: String,
    duDoanMD5: String,
    duDoanCuoi: String,
    md5Hash: String,
    timestamp: { type: Date, default: Date.now }
});
const History = mongoose.model('History', historySchema);

app.use(cors());

// ==========================================
// HÀM HỖ TRỢ - CÁC THUẬT TOÁN CẢI TIẾN
// ==========================================

// 1️⃣ MD5 ANALYSIS CẢI TIẾN (Sử dụng trực tiếp crypto)
function analyzeM5Advanced(md5Hash, diceSum, dices) {
    if (!md5Hash || md5Hash.length === 0) return "Bỏ";
    
    try {
        // Lấy tất cả byte của MD5 (32 ký tự hex = 16 byte)
        let hexSum = 0;
        for (let i = 0; i < md5Hash.length; i += 2) {
            hexSum += parseInt(md5Hash.substr(i, 2), 16);
        }
        
        // Kết hợp với tổng xúc xắc
        let finalValue = hexSum + diceSum;
        
        // Phân tích bit pattern
        const bitPattern = (finalValue >>> 0).toString(2).padStart(32, '0');
        const countOnes = (bitPattern.match(/1/g) || []).length;
        
        // Heuristic: nếu bit 1 nhiều → Tài, ít → Xỉu
        if (countOnes >= 16) return "Tài";
        if (countOnes <= 10) return "Xỉu";
        
        // Fallback: chẵn/lẻ kết hợp
        return (finalValue % 2 === 0) ? "Tài" : "Xỉu";
    } catch (e) {
        return "Bỏ";
    }
}

// 2️⃣ FORM ANALYSIS CẢI TIẾN (Có điều chỉnh từ học tập)
function analyzeFormAdvanced(tong, diceStr, adjustmentFactor = 0) {
    let result = "Bỏ";
    let confidence = 0; // 0-100
    
    // Quy tắc cơ bản + điều chỉnh từ AI
    if (tong <= 4 || tong >= 17) {
        result = "Bỏ";
        confidence = 0;
    } else if (tong <= 10) {
        result = "Xỉu";
        confidence = 75 + adjustmentFactor;
    } else if (tong >= 11 && tong <= 16) {
        result = "Tài";
        confidence = 70 + adjustmentFactor;
    }
    
    // Điều chỉnh theo pattern xúc xắc cụ thể
    if (tong === 6 && diceStr === "123") {
        result = "Tài";
        confidence = 65;
    } else if (tong === 11 && diceStr === "236") {
        result = "Xỉu";
        confidence = 60;
    } else if ([3, 18].includes(tong)) {
        result = "Bỏ";
        confidence = 0;
    }
    
    return { result, confidence };
}

// 3️⃣ MACHINE LEARNING CẢI TIẾN (Weighted recent history + trend analysis)
async function calculateWeightedWinrate(limit = 50) {
    const dbHistory = await History.find({ 
        ketQuaThucTe: { $ne: null },
        duDoanForm: { $ne: null },
        duDoanMD5: { $ne: null }
    })
    .sort({ phien: -1 })
    .limit(limit);
    
    if (dbHistory.length === 0) {
        return {
            winrateForm: 0,
            winrateMD5: 0,
            trend: "Không đủ dữ liệu",
            recentTrend: "neutral"
        };
    }
    
    let totalWeightForm = 0, correctForm = 0;
    let totalWeightMD5 = 0, correctMD5 = 0;
    let recentWins = 0, recentTotal = 0;
    
    // Trọng số giảm dần (tay mới quan trọng hơn)
    for (let i = 0; i < dbHistory.length; i++) {
        const weight = Math.pow(0.95, i); // Exponential decay
        const tay = dbHistory[i];
        
        // Tính Form
        if (tay.duDoanForm !== "Bỏ") {
            totalWeightForm += weight;
            if (tay.duDoanForm === tay.ketQuaThucTe) {
                correctForm += weight;
            }
        }
        
        // Tính MD5
        if (tay.duDoanMD5 !== "Bỏ") {
            totalWeightMD5 += weight;
            if (tay.duDoanMD5 === tay.ketQuaThucTe) {
                correctMD5 += weight;
            }
        }
        
        // Trend gần nhất (10 tay)
        if (i < 10) {
            recentTotal++;
            if ((tay.duDoanCuoi === tay.ketQuaThucTe) && tay.duDoanCuoi !== "Bỏ") {
                recentWins++;
            }
        }
    }
    
    const winrateForm = totalWeightForm > 0 ? ((correctForm / totalWeightForm) * 100).toFixed(1) : 0;
    const winrateMD5 = totalWeightMD5 > 0 ? ((correctMD5 / totalWeightMD5) * 100).toFixed(1) : 0;
    
    // Trend: nếu 10 tay gần chạm 7+ win = đang hot
    let recentTrend = "neutral";
    if (recentWins >= 7) recentTrend = "hot";
    else if (recentWins <= 3) recentTrend = "cold";
    
    // Tính streak sai liên tiếp
    let streakSai = 0;
    for (let i = 0; i < Math.min(3, dbHistory.length); i++) {
        if (dbHistory[i].duDoanCuoi !== dbHistory[i].ketQuaThucTe && dbHistory[i].duDoanCuoi !== "Bỏ") {
            streakSai++;
        }
    }
    
    return {
        winrateForm: parseFloat(winrateForm),
        winrateMD5: parseFloat(winrateMD5),
        trend: `${recentWins}/10 tay gần đúng`,
        recentTrend: recentTrend,
        streakSai: streakSai,
        soPhienPhanTich: dbHistory.length
    };
}

// 4️⃣ HỆ SỐ AN TOÀN NÂNG CAO
function calculateSafetyScore(gioHienTai, streakSai, recentTrend) {
    let score = 100;
    
    // Giờ sòng bẻ cầu (23h-2h)
    if (gioHienTai >= 23 || gioHienTai <= 2) {
        score -= 25;
    }
    
    // Dây đen 3 tay (streak sai)
    if (streakSai >= 3) {
        score -= 40;
    } else if (streakSai === 2) {
        score -= 20;
    }
    
    // Trend lạnh
    if (recentTrend === "cold") {
        score -= 15;
    }
    
    return Math.max(0, score);
}

// 5️⃣ QUYẾT ĐỊNH CUỐI CÙNG
function makeFinalDecision(
    duDoanForm, 
    duDoanMD5, 
    winrateForm, 
    winrateMD5, 
    recentTrend,
    safetyScore
) {
    let duDoan = "Chưa rõ";
    let lyDo = "";
    
    // Nếu hệ số an toàn quá thấp
    if (safetyScore < 40) {
        duDoan = "Bỏ";
        lyDo = `⛔ HỆ SỐ AN TOÀN QUANH GẦNN (${safetyScore}%): Khuyên dừng!`;
        return { duDoan, lyDo };
    }
    
    // Nếu cả 2 đều Bỏ
    if (duDoanForm === "Bỏ" && duDoanMD5 === "Bỏ") {
        duDoan = "Bỏ";
        lyDo = `⚠️ Cả 2 thuật toán khuyên bỏ phiên này.`;
        return { duDoan, lyDo };
    }
    
    // Nếu Form = "Bỏ" nhưng MD5 có dự đoán
    if (duDoanForm === "Bỏ") {
        duDoan = duDoanMD5;
        lyDo = `📊 Dựa theo MD5 (Winrate: ${winrateMD5.toFixed(1)}%).`;
        return { duDoan, lyDo };
    }
    
    // Nếu MD5 = "Bỏ" nhưng Form có dự đoán
    if (duDoanMD5 === "Bỏ") {
        duDoan = duDoanForm;
        lyDo = `📊 Dựa theo Form Xúc Xắc (Winrate: ${winrateForm.toFixed(1)}%).`;
        return { duDoan, lyDo };
    }
    
    // Cả 2 đều có dự đoán
    if (duDoanForm === duDoanMD5) {
        duDoan = duDoanForm;
        lyDo = `🔥 ĐỒNG THUẬN: Cả 2 chỉ ra ${duDoan} | Form: ${winrateForm.toFixed(1)}% | MD5: ${winrateMD5.toFixed(1)}%`;
        return { duDoan, lyDo };
    }
    
    // Xung đột -> chọn thằng nào winrate cao hơn ít nhất 10%
    const diff = Math.abs(winrateForm - winrateMD5);
    if (diff >= 10) {
        if (winrateForm > winrateMD5) {
            duDoan = duDoanForm;
            lyDo = `🤖 Form Xúc Xắc (${winrateForm.toFixed(1)}%) hơn MD5 (${winrateMD5.toFixed(1)}%) ➜ ${duDoan}`;
        } else {
            duDoan = duDoanMD5;
            lyDo = `🤖 MD5 (${winrateMD5.toFixed(1)}%) hơn Form (${winrateForm.toFixed(1)}%) ➜ ${duDoan}`;
        }
    } else {
        // Ngang nhau -> ưu tiên theo trend
        if (recentTrend === "hot") {
            duDoan = duDoanForm;
            lyDo = `🔄 Xung đột + Trend HOT → Ưu tiên Form (${duDoan})`;
        } else if (recentTrend === "cold") {
            duDoan = "Bỏ";
            lyDo = `❄️ Xung đột + Trend LẠNH → Khuyên bỏ!`;
        } else {
            duDoan = duDoanMD5;
            lyDo = `⚖️ Ngang nhau → Ưu tiên MD5 (${duDoan})`;
        }
    }
    
    return { duDoan, lyDo };
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

    // Phiên vừa kết thúc
    const latestSession = data.list[0];
    const phienVuaRa = latestSession.id;
    const dices = latestSession.dices;
    const tong = dices[0] + dices[1] + dices[2];
    const ketQuaVuaRa = tong >= 11 ? 'Tài' : 'Xỉu';
    const diceStr = [...dices].sort((a, b) => a - b).join('');
    const md5Hash = latestSession._id || "";
    
    const phienMoi = phienVuaRa + 1;

    // BƯỚC 1: Cập nhật kết quả thực tế
    await History.updateOne(
        { phien: phienVuaRa }, 
        { 
            ketQuaThucTe: ketQuaVuaRa,
            tong: tong,
            dices: dices,
            md5Hash: md5Hash
        }, 
        { upsert: true }
    );

    // BƯỚC 2: Tính toán dự đoán cho phiên mới
    const duDoanMD5 = analyzeM5Advanced(md5Hash, tong, dices);
    const { result: duDoanForm } = analyzeFormAdvanced(tong, diceStr, 0);
    
    // BƯỚC 3: Lấy thống kê từ 50 tay gần nhất (Weighted)
    const stats = await calculateWeightedWinrate(50);
    
    // BƯỚC 4: Tính hệ số an toàn
    const vnTime = new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"});
    const gioHienTai = new Date(vnTime).getHours();
    const safetyScore = calculateSafetyScore(gioHienTai, stats.streakSai, stats.recentTrend);
    
    // BƯỚC 5: Quyết định cuối cùng
    const { duDoan: duDoanCuoi, lyDo: lyDoCuoi } = makeFinalDecision(
        duDoanForm,
        duDoanMD5,
        stats.winrateForm,
        stats.winrateMD5,
        stats.recentTrend,
        safetyScore
    );
    
    // BƯỚC 6: Lưu dự đoán vào DB
    await History.updateOne(
        { phien: phienMoi }, 
        { 
            duDoanForm: duDoanForm, 
            duDoanMD5: duDoanMD5, 
            duDoanCuoi: duDoanCuoi,
            md5Hash: "pending"
        }, 
        { upsert: true }
    );

    res.json({
        id: "tool_taixiu_pro_AI_v2",
        Phien_vua_ra: phienVuaRa,
        Phien_DU_DOAN: phienMoi,
        
        // Phân tích chi tiết
        Phan_tich_MD5: duDoanMD5,
        Phan_tich_Form: duDoanForm,
        
        // Thống kê ML
        Thong_ke_50_tay: {
            Tong_tay_phan_tich: stats.soPhienPhanTich,
            Winrate_Form: `${stats.winrateForm.toFixed(1)}%`,
            Winrate_MD5: `${stats.winrateMD5.toFixed(1)}%`,
            Trend_10_tay_gan: stats.trend,
            Tinh_huong: stats.recentTrend.toUpperCase(),
            Day_den: stats.streakSai > 0 ? `⚠️ ${stats.streakSai}/3 tay sai` : "✅ OK"
        },
        
        // An toàn
        Gio_VN: gioHienTai,
        He_so_an_toan: `${safetyScore}%`,
        
        // Quyết định
        KET_LUAN: duDoanCuoi,
        Chi_tiet: lyDoCuoi
    });

  } catch(err) {
    console.error("API Error: ", err);
    res.status(500).json({ error: "Lỗi hệ thống: " + err.message });
  }
});

app.listen(port, () => console.log(`🚀 API v2 Đang Chạy...`));
