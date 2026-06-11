// server.js
const express = require('express');
const app = express();
const port = 3000;

// Proxy API gốc + thêm logic dự đoán
app.get('/api/taixiu', async (req, res) => {
  try {
    // Gọi API gốc tele68
    const response = await fetch('https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2');
    const data = await response.json();
    
    const latestSession = data.list[0]; // phiên mới nhất
    const dices = latestSession.dices; // [4,3,2]
    
    // Tính tổng điểm
    const tong = dices[0] + dices[1] + dices[2];
    const ketQua = tong >= 11 ? 'Tài' : 'Xỉu';
    
    // Tạo pattern từ lịch sử (10 phiên gần nhất)
    const pattern = data.list.slice(0, 20).map(s => s.resultTruyenThong === 'TAI' ? 't' : 'x').join('');
    
    // Dự đoán đơn giản: đếm Tài/Xỉu trong 5 phiên gần nhất
    const last5 = data.list.slice(0,5).map(s => s.resultTruyenThong);
    const taiCount = last5.filter(r => r === 'TAI').length;
    const duDoan = taiCount >= 3 ? 'Tài' : 'Xỉu';
    const doTinCay = (taiCount/5 * 100).toFixed(1) + '%';
    
    res.json({
      id: "your_tool_name",
      Phien: latestSession.id,
      phien_hien_tai: latestSession.id + 1,
      Xuc_xac_1: dices[0],
      Xuc_xac_2: dices[1],
      Xuc_xac_3: dices[2],
      Tong: tong,
      Ket_qua: ketQua,
      Pattern: pattern,
      Du_doan: duDoan,
      Do_tin_cay: doTinCay
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`API chạy tại http://localhost:${port}/api/taixiu`));
