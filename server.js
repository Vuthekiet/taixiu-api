const express = require('express');
const cors = require('cors');
const app = express();

const port = process.env.PORT || 3000;

app.use(cors());

app.get('/api/taixiu', async (req, res) => {
  try {
    const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
    const response = await fetch(apiUrl);
    
    if (!response.ok) {
        return res.status(response.status).json({ error: "Lỗi kết nối hoặc Token API đã hết hạn" });
    }

    const data = await response.json();
    
    if (!data?.list || data.list.length < 5) {
      return res.status(500).json({ error: "Dữ liệu API trả về không đủ" });
    }

    const latestSession = data.list[0];
    const dices = latestSession.dices;
    const tong = dices[0] + dices[1] + dices[2];
    const ketQua = tong >= 11 ? 'Tài' : 'Xỉu';
    const diceStr = [...dices].sort((a, b) => a - b).join('');
    
    // ĐÃ SỬA LỖI Ở ĐÂY: Lấy trường "_id" thay vì "md5" theo đúng API gốc của bạn
    const chuoiMD5 = latestSession._id || ""; 

    // 1. THUẬT TOÁN PHÂN TÍCH MD5 (Từ trường _id)
    let duDoanMD5 = "Bỏ";
    let md5FormulaChiTiet = "Không có chuỗi mã";
    
    if (chuoiMD5.length > 0) {
        // Lấy ký tự Đầu, Giữa, Cuối
        const charDau = chuoiMD5.charCodeAt(0);
        const charGiua = chuoiMD5.charCodeAt(Math.floor(chuoiMD5.length / 2));
        const charCuoi = chuoiMD5.charCodeAt(chuoiMD5.length - 1);
        
        // Tổng = 3 ký tự + Điểm phiên trước
        const tongMD5 = charDau + charGiua + charCuoi + tong;
        
        // Chẵn = Tài, Lẻ = Xỉu
        duDoanMD5 = (tongMD5 % 2 === 0) ? "Tài" : "Xỉu";
        md5FormulaChiTiet = `ASCII(${charDau}+${charGiua}+${charCuoi}) + Điểm(${tong}) = ${tongMD5} -> ${tongMD5 % 2 === 0 ? 'Chẵn' : 'Lẻ'} = ${duDoanMD5}`;
    }

    // 2. THUẬT TOÁN FORM XÚC XẮC
    let duDoanForm = "Bỏ";
    switch (tong) {
      case 3: case 18: duDoanForm = "Bỏ"; break;
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
      case 17: duDoanForm = "Bỏ"; break;
      default: duDoanForm = "Bỏ";
    }

    // 3. TỔNG HỢP LOGIC
    let duDoanCuoi = "Chưa rõ";
    let doTinCay = "0%";
    let lyDoCuoi = "";

    if (duDoanForm === "Bỏ") {
        duDoanCuoi = duDoanMD5;
        doTinCay = "60%";
        lyDoCuoi = `Form báo Bỏ. Chốt theo MD5: ${md5FormulaChiTiet}`;
    } else if (duDoanForm === duDoanMD5) {
        duDoanCuoi = duDoanMD5;
        doTinCay = "85%";
        lyDoCuoi = `ĐỒNG THUẬN: Form (${diceStr}) và MD5 đều báo ${duDoanCuoi}. (${md5FormulaChiTiet})`;
    } else {
        duDoanCuoi = duDoanMD5;
        doTinCay = "55%";
        lyDoCuoi = `XUNG ĐỘT: Form báo ${duDoanForm}, MD5 báo ${duDoanMD5} -> Ưu tiên MD5 (${md5FormulaChiTiet})`;
    }

    res.json({
      id: "tool_taixiu_md5",
      Phien: latestSession.id,
      Phien_du_doan: latestSession.id + 1,
      MD5_Chuoi: chuoiMD5, 
      Xuc_xac: dices.join(' - '),
      Tong_diem_phien_truoc: tong,
      Du_doan_MD5: duDoanMD5,
      Du_doan_Form_Vi: duDoanForm,
      CHOT_DU_DOAN: duDoanCuoi,
      Do_tin_cay: doTinCay,
      Chi_tiet: lyDoCuoi
    });

  } catch(err) {
    console.error("API Error: ", err);
    res.status(500).json({ error: "Lỗi hệ thống nội bộ: " + err.message });
  }
});

app.listen(port, () => console.log(`🚀 API đang chạy tại Port: ${port}`));
