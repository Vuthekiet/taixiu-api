const express = require('express');
const app = express();
const port = 3000;

app.get('/api/taixiu', async (req, res) => {
  try {
    // Gọi API gốc lấy toàn bộ danh sách lịch sử
    const response = await fetch('https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2');
    const data = await response.json();
    
    if (!data || !data.list || data.list.length === 0) {
      return res.status(500).json({ error: "Không lấy được dữ liệu từ API gốc" });
    }

    const totalSessions = data.list.length; // Tổng số phiên hệ thống lấy được (lên tới 300 phiên)
    const latestSession = data.list[0];    // Phiên mới nhất vừa ra
    const dices = latestSession.dices;
    const tong = dices[0] + dices[1] + dices[2];
    const ketQua = tong >= 11 ? 'Tài' : 'Xỉu';
    
    // 1. Chuyển đổi toàn bộ lịch sử thành chuỗi ký tự để học tập (Mới nhất đứng đầu)
    // 't' = Tài, 'x' = Xỉu. Ví dụ: "ttxtxx..."
    const fullPattern = data.list.map(s => s.resultTruyenThong === 'TAI' ? 't' : 'x').join('');
    
    // Đảo ngược chuỗi để học từ quá khứ đến hiện tại (Dễ tính toán theo trục thời gian)
    const historyStr = fullPattern.split('').reverse().join('');

    // 2. Lấy mẫu cầu hiện tại (3 phiên gần nhất vừa ra) để đi "tìm kiếm quá khứ"
    // Ví dụ 3 phiên gần nhất là: Tài, Xỉu, Tài -> mẫu cần tìm là "txt"
    const currentPattern = fullPattern.slice(0, 3).split('').reverse().join('');

    // 3. THUẬT TOÁN HỌC TẬP (Markov Chain / Pattern Matching)
    let nextIsTai = 0;
    let nextIsXiu = 0;
    let matchCount = 0;

    // Quét toàn bộ chiều dài lịch sử (Dữ liệu học tập lên tới 300 phiên)
    for (let i = 0; i < historyStr.length - currentPattern.length; i++) {
      // Trích xuất một đoạn cầu dài 3 ký tự trong quá khứ
      const pastPattern = historyStr.substring(i, i + currentPattern.length);
      
      // Nếu đoạn cầu trong quá khứ giống hệt mẫu cầu hiện tại
      if (pastPattern === currentPattern) {
        matchCount++;
        // Xem phiên ngay sau đoạn cầu đó trong quá khứ ra cái gì
        const nextResult = historyStr.charAt(i + currentPattern.length);
        if (nextResult === 't') nextIsTai++;
        if (nextResult === 'x') nextIsXiu++;
      }
    }

    // 4. ĐƯA RA DỰ ĐOÁN DỰA TRÊN DỮ LIỆU ĐÃ HỌC
    let duDoan = "Chưa rõ";
    let doTinCay = "50%";

    if (matchCount > 0) {
      // Tính tỷ lệ xuất hiện trong lịch sử
      const tileTai = (nextIsTai / matchCount) * 100;
      const tileXiu = (nextIsXiu / matchCount) * 100;

      if (tileTai > tileXiu) {
        duDoan = "Tài";
        doTinCay = tileTai.toFixed(1) + "%";
      } else if (tileXiu > tileTai) {
        duDoan = "Xỉu";
        doTinCay = tileXiu.toFixed(1) + "%";
      } else {
        // Nếu tỷ lệ quá khứ là 50/50, dùng thuật toán phụ: Đếm 5 phiên gần nhất
        const last5Tai = fullPattern.slice(0, 5).split('').filter(x => x === 't').length;
        duDoan = last5Tai >= 3 ? "Tài" : "Xỉu";
        doTinCay = "55% (Cân bằng)";
      }
    } else {
      // Nếu mẫu cầu này quá dị, chưa từng xuất hiện trong 300 phiên quá khứ
      const last5Tai = fullPattern.slice(0, 5).split('').filter(x => x === 't').length;
      duDoan = last5Tai >= 3 ? "Tài" : "Xỉu";
      doTinCay = "52% (Mẫu mới)";
    }

    // Trả về kết quả JSON cho Tool của bạn
    res.json({
      id: "ai_markov_tool",
      Phien: latestSession.id,
      phien_hien_tai: latestSession.id + 1,
      Xuc_xac_1: dices[0],
      Xuc_xac_2: dices[1],
      Xuc_xac_3: dices[2],
      Tong: tong,
      Ket_qua: ketQua,
      So_phiên_da_hoc: totalSessions, 
      So_lan_trung_khớp_qua_khu: matchCount,
      Du_doan: duDoan,
      Do_tin_cay: doTinCay,
      Chuoi_lich_su_ngan: fullPattern.slice(0, 30) // Hiện 30 phiên gần nhất cho gọn
    });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`AI Server chạy tại port ${port}`));
