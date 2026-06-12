const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const app = express();

const port = process.env.PORT || 3000;

// ==========================================
// THIẾT LẬP KẾT NỐI MONGODB TẠI ĐÂY
// ==========================================
// THAY MẬT KHẨU CỦA BẠN VÀO ĐOẠN <db_password>
const MONGODB_URI = "mongodb+srv://Bolakiettrumtx:<Kiet280911>@cluster0.izuwm8b.mongodb.net/taixiuDB?retryWrites=true&w=majority";

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Đã kết nối Cơ sở dữ liệu MongoDB thành công!'))
  .catch(err => console.error('❌ Lỗi kết nối DB:', err));

// ==========================================
// TẠO CẤU TRÚC LƯU TRỮ DỮ LIỆU (SCHEMA)
// ==========================================
const historySchema = new mongoose.Schema({
    phien: { type: Number, required: true, unique: true },
    ketQuaThucTe: { type: String, default: null }, // Khi phiên kết thúc mới có
    duDoanForm: String,
    duDoanMD5: String,
    duDoanCuoi: String
});
const History = mongoose.model('History', historySchema);

app.use(cors());

app.get('/api/taixiu', async (req, res) => {
  try {
    const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
    const response = await fetch(apiUrl);
    
    if (!response.ok) return res.status(response.status).json({ error: "Lỗi API gốc" });
    const data = await response.json();
    if (!data?.list || data.list.length < 5) return res.status(500).json({ error: "Thiếu data" });

    // Lấy dữ liệu phiên VỪA KẾT THÚC
    const latestSession = data.list[0];
    const phienVuaRa = latestSession.id;
    const dices = latestSession.dices;
    const tong = dices[0] + dices[1] + dices[2];
    const ketQuaVuaRa = tong >= 11 ? 'Tài' : 'Xỉu';
    const diceStr = [...dices].sort((a, b) => a - b).join('');
    const chuoiMD5 = latestSession._id || ""; 

    // Phiên chúng ta cần DỰ ĐOÁN là phiên tiếp theo
    const phienMoi = phienVuaRa + 1;

    // --- BƯỚC A: CẬP NHẬT KẾT QUẢ THỰC TẾ CHO PHIÊN VỪA RỒI VÀO DB ---
    await History.updateOne(
        { phien: phienVuaRa }, 
        { ketQuaThucTe: ketQuaVuaRa }, 
        { upsert: true }
    );

    // --- BƯỚC B: TÍNH TOÁN CÔNG THỨC CHO PHIÊN MỚI ---
    // 1. MD5
    let duDoanMD5 = "Bỏ";
    if (chuoiMD5.length > 0) {
        const c1 = chuoiMD5.charCodeAt(0);
        const c2 = chuoiMD5.charCodeAt(Math.floor(chuoiMD5.length / 2));
        const c3 = chuoiMD5.charCodeAt(chuoiMD5.length - 1);
        const tongMD5 = c1 + c2 + c3 + tong;
        duDoanMD5 = (tongMD5 % 2 === 0) ? "Tài" : "Xỉu";
    }

    // 2. Form Vị Xúc Xắc
    let duDoanForm = "Bỏ";
    switch (tong) {
      case 3: case 18: case 17: duDoanForm = "Bỏ"; break;
      case 4: case 5: duDoanForm = "Xỉu"; break;
      case 6: duDoanForm = (diceStr === "123") ? "Tài" : "Xỉu"; break;
      case 7: duDoanForm = (["124", "223", "133"].includes(diceStr)) ? "Xỉu" : "Tài"; break;
      case 8: duDoanForm = (diceStr === "134") ? "Xỉu" : "Tài"; break;
      case 9: duDoanForm = (["234", "135"].includes(diceStr)) ? "Xỉu" : "Tài"; break;
      case 10: duDoanForm = (["136", "145", "235"].includes(diceStr)) ? "Xỉu" : "Tài"; break;
      case 11: duDoanForm = (diceStr === "236") ? "Xỉu" : "Tài"; break;
      case 12: duDoanForm = (["246", "156", "336", "255"].includes(diceStr)) ? "Xỉu" : "Tài"; break;
      case 13: duDoanForm = (diceStr === "345") ? "Tài" : "Xỉu"; break;
      case 14: duDoanForm = (diceStr === "266") ? "Xỉu" : "Tài"; break;
      case 15: duDoanForm = (diceStr === "456") ? "Xỉu" : "Tài"; break;
      case 16: duDoanForm = (diceStr === "556") ? "Xỉu" : "Tài"; break;
      default: duDoanForm = "Bỏ";
    }

    // --- BƯỚC C: AI TỰ HỌC TỪ 50 TAY GẦN NHẤT (MACHINE LEARNING CƠ BẢN) ---
    // Lấy 50 tay đã có kết quả thực tế để chấm điểm
    const dbLichSu = await History.find({ ketQuaThucTe: { $ne: null } }).sort({ phien: -1 }).limit(50);
    
    let diemForm = 0; let diemMD5 = 0; let soTayDaChay = dbLichSu.length;
    let soTaySaiLienTiep = 0;
    let chuoiThuaBatDau = false;

    for (let i = 0; i < soTayDaChay; i++) {
        const tay = dbLichSu[i];
        if (tay.duDoanForm === tay.ketQuaThucTe && tay.duDoanForm !== "Bỏ") diemForm++;
        if (tay.duDoanMD5 === tay.ketQuaThucTe && tay.duDoanMD5 !== "Bỏ") diemMD5++;
        
        // Đếm dây đen (3 tay gần nhất)
        if (i < 3) {
            if (tay.duDoanCuoi !== tay.ketQuaThucTe && tay.duDoanCuoi !== "Bỏ") {
                soTaySaiLienTiep++;
            }
        }
    }

    if (soTaySaiLienTiep >= 3) chuoiThuaBatDau = true;

    let tyLeForm = soTayDaChay > 0 ? ((diemForm / soTayDaChay) * 100).toFixed(1) : 0;
    let tyLeMD5 = soTayDaChay > 0 ? ((diemMD5 / soTayDaChay) * 100).toFixed(1) : 0;

    // --- BƯỚC D: LỌC NHIỄU NHÀ CÁI (KHUNG GIỜ & DÂY ĐEN) ---
    // Chuyển giờ về múi giờ VN (GMT+7)
    const vnTime = new Date().toLocaleString("en-US", {timeZone: "Asia/Ho_Chi_Minh"});
    const gioHienTai = new Date(vnTime).getHours();
    
    let heSoAnToan = 100;
    let canhBao = "";

    if (gioHienTai >= 23 || gioHienTai <= 2) {
        canhBao += "[⚠️ LƯU Ý: Đang trong giờ sòng hay bẻ cầu] ";
        heSoAnToan -= 30;
    }
    if (chuoiThuaBatDau) {
        canhBao += "[🛑 BÁO ĐỘNG: Tool vừa sai 3 tay liên tiếp. Nhà cái đang soi mã thiết bị, hãy tắt trình duyệt nghỉ 15p!] ";
        heSoAnToan -= 50;
    }

    // --- BƯỚC E: CHỐT KẾT QUẢ CUỐI CÙNG DỰA VÀO ĐIỂM AI CHẤM ---
    let duDoanCuoi = "Chưa rõ";
    let lyDoCuoi = "";

    if (duDoanForm === duDoanMD5) {
        duDoanCuoi = duDoanMD5;
        lyDoCuoi = `🔥 ĐỒNG THUẬN: Cả 2 thuật toán đều chỉ ra ${duDoanCuoi}.`;
    } else {
        // Cầu xung đột -> Thằng nào winrate cao hơn thì theo thằng đó
        if (parseFloat(tyLeForm) > parseFloat(tyLeMD5) + 5) {
            duDoanCuoi = duDoanForm;
            lyDoCuoi = `🤖 AI NHẬN ĐỊNH: Đè Form Xúc Xắc (Winrate: ${tyLeForm}%) đang ăn chặt hơn MD5 (Winrate: ${tyLeMD5}%).`;
        } else if (parseFloat(tyLeMD5) > parseFloat(tyLeForm) + 5) {
            duDoanCuoi = duDoanMD5;
            lyDoCuoi = `🤖 AI NHẬN ĐỊNH: Theo thuật toán MD5 (Winrate: ${tyLeMD5}%) vì Form đang gãy (Winrate: ${tyLeForm}%).`;
        } else {
            duDoanCuoi = duDoanMD5; // Hòa thì chốt MD5
            lyDoCuoi = `Xung đột: Winrate 2 thuật toán đang ngang nhau. Ưu tiên nhẹ MD5.`;
        }
    }

    // Nếu hệ số an toàn quá thấp, AI khuyên BỎ
    if (heSoAnToan < 50) {
        lyDoCuoi = canhBao + " -> " + lyDoCuoi;
    }

    // --- BƯỚC F: LƯU DỰ ĐOÁN MỚI VÀO DB ĐỂ PHIÊN SAU CHẤM ĐIỂM ---
    await History.updateOne(
        { phien: phienMoi }, 
        { 
            duDoanForm: duDoanForm, 
            duDoanMD5: duDoanMD5, 
            duDoanCuoi: duDoanCuoi 
        }, 
        { upsert: true }
    );

    res.json({
        id: "tool_taixiu_pro_AI",
        Phien_vua_ra: phienVuaRa,
        Phien_DU_DOAN: phienMoi,
        He_thong_tu_hoc: `Đã phân tích ${soTayDaChay} tay gần nhất`,
        Ty_le_thang_Form: `${tyLeForm}%`,
        Ty_le_thang_MD5: `${tyLeMD5}%`,
        Du_doan_MD5: duDoanMD5,
        Du_doan_Form_Vi: duDoanForm,
        CHOT_DU_DOAN: duDoanCuoi,
        Do_An_Toan_Cau: `${heSoAnToan}%`,
        Chi_tiet_AI: lyDoCuoi
    });

  } catch(err) {
    console.error("API Error: ", err);
    res.status(500).json({ error: "Lỗi hệ thống: " + err.message });
  }
});

app.listen(port, () => console.log(`🚀 SIÊU API Đang Chạy...`));
