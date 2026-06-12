const express = require('express');
const app = express();
const port = 3000;

app.get('/api/taixiu', async (req, res) => {
  try {
    const response = await fetch('https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2');
    const data = await response.json();
    
    if (!data || !data.list || data.list.length === 0) {
      return res.status(500).json({ error: "Không lấy được dữ liệu từ API gốc" });
    }

    const latestSession = data.list[0];
    const dices = latestSession.dices;
    const tong = dices[0] + dices[1] + dices[2];
    const ketQua = tong >= 11 ? 'Tài' : 'Xỉu';

    // Lấy lịch sử 20 phiên và 5 phiên gần nhất
    const history20 = data.list.slice(0, 20).map(s => s.resultTruyenThong);
    const history5 = history20.slice(0, 5);

    let duDoan = "Tài";
    let doTinCay = "50%";
    let lyDo = "Dựa trên xác suất cơ bản";

    const countTai20 = history20.filter(r => r === 'TAI').length;
    const countXiu20 = 20 - countTai20;

    // --- LOGIC 1: Bù Trừ Server (Ưu tiên cao nhất) ---
    if (countTai20 >= 14) {
      duDoan = "Xỉu";
      doTinCay = "85%";
      lyDo = "Tỉ lệ Tài 20 phiên đang quá cao, dự đoán server bù trừ về Xỉu";
    } else if (countXiu20 >= 14) {
      duDoan = "Tài";
      doTinCay = "85%";
      lyDo = "Tỉ lệ Xỉu 20 phiên đang quá cao, dự đoán server bù trừ về Tài";
    }
    // --- LOGIC 2: Bật Nhả Điểm Số (Ưu tiên hai) ---
    else if (tong >= 16) {
      duDoan = "Xỉu";
      doTinCay = "80%";
      lyDo = `Điểm phiên trước chạm trần (${tong} điểm), dự đoán rớt Xỉu`;
    } else if (tong <= 5) {
      duDoan = "Tài";
      doTinCay = "80%";
      lyDo = `Điểm phiên trước chạm đáy (${tong} điểm), dự đoán bật lên Tài`;
    }
    // --- LOGIC 3: Đu Trend Cầu Ngắn (Ưu tiên ba) ---
    else {
      const countTai5 = history5.filter(r => r === 'TAI').length;
      if (countTai5 >= 4) {
        duDoan = "Tài";
        doTinCay = "70%";
        lyDo = "Cầu 5 phiên đang thuận Tài, đánh theo trend";
      } else if (countTai5 <= 1) {
        duDoan = "Xỉu";
        doTinCay = "70%";
        lyDo = "Cầu 5 phiên đang thuận Xỉu, đánh theo trend";
      } else {
        // Nếu không có trend rõ ràng, đánh ngược phiên trước (bắt cầu 1-1)
        duDoan = history5[0] === 'TAI' ? "Xỉu" : "Tài";
        doTinCay = "55%";
        lyDo = "Cầu đang đi ngang (sideway), dự đoán đánh đảo phiên trước";
      }
    }

    // Trả kết quả về cho Tool
    res.json({
      id: "gemini_logic_v1",
      Phien: latestSession.id,
      phien_hien_tai: latestSession.id + 1,
      Tong_diem_phien_truoc: tong,
      Ket_qua_phien_truoc: ketQua,
      Ty_le_Tai_20_phien: (countTai20 / 20 * 100).toFixed(0) + "%",
      Ty_le_Xiu_20_phien: (countXiu20 / 20 * 100).toFixed(0) + "%",
      Du_doan: duDoan,
      Do_tin_cay: doTinCay,
      Ly_do_du_doan: lyDo
    });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`API chạy tại port ${port}`));
