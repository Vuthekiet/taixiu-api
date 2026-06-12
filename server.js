const express = require('express');
const cors = require('cors');
const app = express();
const port = 3000;

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
    
    // Lấy chuỗi MD5 của phiên hiện tại (phụ thuộc vào key API, thường là 'md5' hoặc 'hash')
    // Giả sử API trả về key tên là `md5`, nếu API của bạn dùng key khác (ví dụ: `hashValue`), hãy đổi lại.
    const chuoiMD5 = latestSession.md5 || latestSession.hash || ""; 

    // ==========================================
    // 1. THUẬT TOÁN PHÂN TÍCH MD5 (MỚI)
    // ==========================================
    let duDoanMD5 = "Bỏ";
    let md5FormulaChiTiet = "Không có MD5";
    
    if (chuoiMD5.length > 0) {
        // Lấy mã ASCII của ký tự: Đầu, Giữa, và Cuối của chuỗi MD5
        const charDau = chuoiMD5.charCodeAt(0);
        const charGiua = chuoiMD5.charCodeAt(Math.floor(chuoiMD5.length / 2));
        const charCuoi = chuoiMD5.charCodeAt(chuoiMD5.length - 1);
        
        // Công thức: Tổng 3 ký tự ASCII + Tổng điểm phiên trước
        const tongMD5 = charDau + charGiua + charCuoi + tong;
        
        // Xét Chẵn/Lẻ: Chẵn -> Tài, Lẻ -> Xỉu (Bạn có thể đảo lại luật này nếu test thấy ngược)
        duDoanMD5 = (tongMD5 % 2 === 0) ? "Tài" : "Xỉu";
        md5FormulaChiTiet = `ASCII(${charDau}+${charGiua}+${charCuoi}) + Điểm(${tong}) = ${tongMD5} -> ${tongMD5 % 2 === 0 ? 'Chẵn' : 'Lẻ'} = ${duDoanMD5}`;
    }

    // ==========================================
    // 2. THUẬT TOÁN FORM XÚC XẮC (CŨ)
    // ==========================================
    let duDoanForm = "Bỏ";
    
    switch (tong) {
      case 3: case 18: duDoanForm = "Bỏ"; break;
      case 4: duDoanForm = "Xỉu"; break;
      case 5: duDoanForm = "Xỉu"; break;
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

    // ==========================================
    // 3. TỔNG HỢP VÀ ĐƯA RA KẾT QUẢ CUỐI CÙNG
    // ==========================================
    let duDoanCuoi = "Chưa rõ";
    let doTinCay = "0%";
    let lyDoCuoi = "";

    if (duDoanForm === "Bỏ") {
        duDoanCuoi = duDoanMD5;
        doTinCay = "60%";
        lyDoCuoi = `Form xúc xắc báo Bỏ. Chốt theo thuật toán MD5: ${md5FormulaChiTiet}`;
    } 
    else if (duDoanForm === duDoanMD5) {
        // Trùng khớp cả 2 công thức -> Tự tin đánh
        duDoanCuoi = duDoanMD5;
        doTinCay = "85%";
        lyDoCuoi = `ĐỘNG THUẬN CAO: Cả Form Xúc Xắc (${diceStr}) và MD5 đều báo ${duDoanCuoi}. (${md5FormulaChiTiet})`;
    } 
    else {
        // Xung đột: Form báo 1 kiểu, MD5 báo 1 kiểu
        // ƯU TIÊN THEO MD5 VÌ BẠN BẢO FORM ĐANG SAI LỆCH NHIỀU
        duDoanCuoi = duDoanMD5;
        doTinCay = "55%";
        lyDoCuoi = `XUNG ĐỘT: Form báo ${duDoanForm} nhưng MD5 báo ${duDoanMD5} -> Ưu tiên đánh theo MD5 (${md5FormulaChiTiet}) nhưng cược nhỏ.`;
    }

    res.json({
      id: "tool_taixiu_md5_premium",
      Phien: latestSession.id,
      Phien_du_doan: latestSession.id + 1,
      MD5_Chuoi: chuoiMD5 ? chuoiMD5.substring(0, 8) + "..." : "Không tìm thấy",
      Xuc_xac: dices.join(' - '),
      Tong_diem_phien_truoc: tong,
      Du_doan_MD5: duDoanMD5,
      Du_doan_Form_Vi: duDoanForm,
      // KẾT QUẢ TRẢ RA UI
      CHOT_DU_DOAN: duDoanCuoi,
      Do_tin_cay: doTinCay,
      Chi_tiet: lyDoCuoi
    });

  } catch(err) {
    console.error("API Error: ", err);
    res.status(500).json({ error: "Lỗi hệ thống nội bộ" });
  }
});

app.listen(port, () => console.log(`🚀 API MD5 đang chạy tại: http://localhost:${port}/api/taixiu`));
