const express = require('express');
const app = express();
const port = 3000;

app.get('/api/taixiu', async (req, res) => {
  try {
    const response = await fetch('https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2');
    const data = await response.json();
    
    if (!data || !data.list || data.list.length === 0) {
      return res.status(500).json({ error: "Không lấy được dữ liệu từ API" });
    }

    const latestSession = data.list[0];
    const dices = latestSession.dices; // [x, y, z]
    const tong = dices[0] + dices[1] + dices[2];
    const ketQua = tong >= 11 ? 'Tài' : 'Xỉu';

    // Sắp xếp xúc xắc từ nhỏ đến lớn để dễ nhận diện (VD: 2-1-1 thành "112")
    const diceStr = [...dices].sort().join('');
    
    // Lấy lịch sử 5 phiên để soi cầu 1-1
    const hist5 = data.list.slice(0, 5).map(s => s.resultTruyenThong === 'TAI' ? 'T' : 'X').join('');

    let duDoan = "Chưa rõ";
    let doTinCay = "50%";
    let lyDo = "Không có dữ liệu công thức cụ thể";

    // --- KIỂM TRA CẦU 1-1 (Ưu tiên kiểm tra trend trước) ---
    // Nếu 4 phiên gần nhất đang ra dạng T-X-T-X hoặc X-T-X-T
    if (hist5.startsWith("TXTX") || hist5.startsWith("XTXT")) {
      duDoan = hist5[0] === 'T' ? "Xỉu" : "Tài";
      doTinCay = "65%";
      lyDo = "Phát hiện cầu 1-1, đánh theo nhịp đảo";
    } else {
      // --- ÁP DỤNG BỘ CÔNG THỨC ĐIỂM VỊ CỦA BẠN ---
      switch (tong) {
        case 3:
          duDoan = "Xỉu"; doTinCay = "70%"; lyDo = "Xỉu 3 -> 70% Xỉu";
          break;
        case 4:
          if (diceStr === "112") { duDoan = "Xỉu"; doTinCay = "75%"; lyDo = "Xỉu 4 ra bộ 1-1-2 -> Dễ lên Xỉu 8"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = "Xỉu 4 thường -> Bẻ Tài"; } // Tùy chọn mặc định
          break;
        case 5:
          duDoan = "Xỉu"; doTinCay = "70%"; lyDo = "Xỉu 5 -> 70% Xỉu";
          break;
        case 6:
          if (diceStr === "123") { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Xỉu 6 ra 1-2-3 -> Có thể ra Tài"; }
          else if (diceStr === "114") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Xỉu 6 ra 1-1-4 -> Sẽ ra Xỉu"; }
          else { duDoan = "Xỉu"; doTinCay = "55%"; lyDo = "Xỉu 6 thường -> Đoán Xỉu"; }
          break;
        case 7:
          if (["124", "223", "133"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "89%"; lyDo = "Xỉu 7 ra đúng form chuẩn -> 89% ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "60%"; lyDo = "Xỉu 7 form khác -> Đoán bẻ Tài"; }
          break;
        case 8:
          if (diceStr === "134") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Xỉu 8 ra 1-3-4 -> Có thể ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "70%"; lyDo = "Xỉu 8 các form còn lại -> Đánh Tài hết"; }
          break;
        case 9:
          if (["234", "135"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Xỉu 9 ra 2-3-4 hoặc 1-3-5 -> Đánh Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Xỉu 9 form còn lại -> Có thể ra Tài"; }
          break;
        case 10:
          if (["136", "145", "235"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "60%"; lyDo = "Xỉu 10 ra form chuẩn -> 60% Xỉu / 40% Tài"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = "Xỉu 10 form khác -> Đoán Tài"; }
          break;
        case 11:
          if (diceStr === "236") { duDoan = "Xỉu"; doTinCay = "70%"; lyDo = "Tài 11 ra 2-3-6 -> 70% Xỉu / 30% Tài"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = "Tài 11 thường -> Giữ Tài"; }
          break;
        case 12:
          if (["246", "156", "336", "255"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "85%"; lyDo = "Tài 12 ra form tử huyệt -> Auto ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "70%"; lyDo = "Tài 12 form còn lại -> Đánh Tài"; }
          break;
        case 13:
          if (diceStr === "345") { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Tài 13 ra 3-4-5 -> Có thể lên Tài 12 (Đánh Tài)"; }
          else { duDoan = "Xỉu"; doTinCay = "55%"; lyDo = "Tài 13 thường"; }
          break;
        case 14:
          if (diceStr === "356") { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Tài 14 ra 3-5-6 -> Có thể lên Tài"; }
          else if (diceStr === "266") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Tài 14 ra 2-6-6 -> Có thể ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = "Tài 14 thường"; }
          break;
        case 15:
          if (diceStr === "456") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Tài 15 ra 4-5-6 -> Có thể ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = "Tài 15 thường"; }
          break;
        case 16:
          if (diceStr === "556") { duDoan = "Xỉu"; doTinCay = "80%"; lyDo = "Tài 16 ra 5-5-6 -> 80% là Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = "Tài 16 thường"; }
          break;
        case 17:
        case 18:
          duDoan = "Bỏ"; doTinCay = "0%"; lyDo = "Điểm quá cao (17, 18) -> Bỏ qua không đánh";
          break;
        default:
          duDoan = "Bỏ"; doTinCay = "0%"; lyDo = "Lỗi điểm số";
      }
    }

    res.json({
      id: "tool_cong_thuc_rieng",
      Phien: latestSession.id,
      phien_hien_tai: latestSession.id + 1,
      Xuc_xac: dices.join(' - '),
      Tong_diem_phien_truoc: tong,
      Ket_qua_phien_truoc: ketQua,
      Du_doan: duDoan,
      Do_tin_cay: doTinCay,
      Chi_tiet_cong_thuc: lyDo
    });

  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => console.log(`API chạy tại port ${port}`));
