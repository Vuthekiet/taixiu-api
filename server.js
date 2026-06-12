const express = require('express');
const cors = require('cors'); // THÊM: Cần thiết để web Frontend có thể gọi được API này
const app = express();
const port = 3000;

// Cấp phép cho mọi domain gọi API
app.use(cors());

app.get('/api/taixiu', async (req, res) => {
  try {
    // LƯU Ý: Token 'at=...' có thể sẽ hết hạn. Nếu lỗi, bạn cần lấy link API mới thay vào đây.
    const apiUrl = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2';
    
    const response = await fetch(apiUrl);
    
    // Kiểm tra API có trả về mã lỗi HTTP không (VD: 403 Forbidden, 500 Error)
    if (!response.ok) {
        return res.status(response.status).json({ error: "Lỗi kết nối hoặc Token API đã hết hạn" });
    }

    const data = await response.json();
    
    // Đảm bảo dữ liệu list tồn tại và có ít nhất 5 phiên để soi cầu
    if (!data?.list || data.list.length < 5) {
      return res.status(500).json({ error: "Dữ liệu API trả về không đủ để phân tích" });
    }

    const latestSession = data.list[0];
    const dices = latestSession.dices; // [x, y, z]
    const tong = dices[0] + dices[1] + dices[2];
    const ketQua = tong >= 11 ? 'Tài' : 'Xỉu';

    // Sắp xếp xúc xắc từ nhỏ đến lớn (VD: [2,1,1] -> "112")
    const diceStr = [...dices].sort((a, b) => a - b).join('');
    
    // Lấy lịch sử 5 phiên gần nhất (T: Tài, X: Xỉu)
    const hist5 = data.list.slice(0, 5).map(s => s.resultTruyenThong === 'TAI' ? 'T' : 'X').join('');

    let duDoan = "Chưa rõ";
    let doTinCay = "50%";
    let lyDo = "Không có dữ liệu công thức cụ thể";

    // --- 1. KIỂM TRA CẦU 1-1 (Ưu tiên kiểm tra trend trước) ---
    // Ví dụ hist5 = TXTXT (Tài-Xỉu-Tài-Xỉu-Tài) -> Phiên tới bắt Xỉu
    if (hist5.startsWith("TXTX") || hist5.startsWith("XTXT")) {
      duDoan = hist5[0] === 'T' ? "Xỉu" : "Tài";
      doTinCay = "75%";
      lyDo = "Phát hiện cầu 1-1 dài, đánh nhịp đảo tiếp theo";
    } 
    // --- 2. ÁP DỤNG BỘ CÔNG THỨC ĐIỂM VỊ ---
    else {
      switch (tong) {
        case 3: // Chỉ có thể là 1-1-1 (Bão)
        case 18: // Chỉ có thể là 6-6-6 (Bão)
          duDoan = "Bỏ"; doTinCay = "0%"; lyDo = `Ra Bão (${diceStr}) -> Nhà cái ăn trọn, bỏ qua không đánh`;
          break;
        case 4: // Tổng 4 chỉ có 1 trường hợp duy nhất là 1-1-2
          duDoan = "Xỉu"; doTinCay = "75%"; lyDo = "Xỉu 4 ra bộ 1-1-2 -> Dễ tiếp tục Xỉu 8";
          break;
        case 5: // Tổng 5 chỉ có 1-1-3 hoặc 1-2-2
          duDoan = "Xỉu"; doTinCay = "70%"; lyDo = `Xỉu 5 (${diceStr}) -> 70% rớt lại Xỉu`;
          break;
        case 6:
          if (diceStr === "123") { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Xỉu 6 ra sảnh 1-2-3 -> Dễ bẻ Tài"; }
          else if (diceStr === "114") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Xỉu 6 ra 1-1-4 -> Sẽ ra Xỉu"; }
          else { duDoan = "Xỉu"; doTinCay = "55%"; lyDo = `Xỉu 6 form ${diceStr} -> Đoán Xỉu`; } // form 222 (Bão) sẽ rơi vào đây nhưng Bão 6 ít xảy ra, nếu muốn có thể check bão
          break;
        case 7:
          if (["124", "223", "133"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "89%"; lyDo = "Xỉu 7 ra đúng form chuẩn -> 89% ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "60%"; lyDo = `Xỉu 7 form ${diceStr} -> Đoán bẻ Tài`; } // Form 115
          break;
        case 8:
          if (diceStr === "134") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Xỉu 8 ra 1-3-4 -> Có thể ra Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "70%"; lyDo = `Xỉu 8 form ${diceStr} -> Đánh bẻ Tài`; }
          break;
        case 9:
          if (["234", "135"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Xỉu 9 ra 2-3-4 hoặc 1-3-5 -> Đánh Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "65%"; lyDo = `Xỉu 9 form ${diceStr} -> Có thể ra Tài`; }
          break;
        case 10:
          if (["136", "145", "235"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "60%"; lyDo = "Xỉu 10 ra form chuẩn -> 60% Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = `Xỉu 10 form ${diceStr} -> Đoán Tài`; }
          break;
        case 11:
          if (diceStr === "236") { duDoan = "Xỉu"; doTinCay = "70%"; lyDo = "Tài 11 ra 2-3-6 -> 70% bẻ Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = `Tài 11 form ${diceStr} -> Giữ Tài`; }
          break;
        case 12:
          if (["246", "156", "336", "255"].includes(diceStr)) { duDoan = "Xỉu"; doTinCay = "85%"; lyDo = "Tài 12 ra form tử huyệt -> Auto bẻ Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "70%"; lyDo = `Tài 12 form ${diceStr} -> Đánh Tài`; }
          break;
        case 13:
          if (diceStr === "345") { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Tài 13 ra 3-4-5 -> Lên Tài 12 (Đánh Tài)"; }
          else { duDoan = "Xỉu"; doTinCay = "55%"; lyDo = `Tài 13 form ${diceStr} -> Xuống Xỉu`; }
          break;
        case 14:
          if (diceStr === "356") { duDoan = "Tài"; doTinCay = "65%"; lyDo = "Tài 14 ra 3-5-6 -> Giữ Tài"; }
          else if (diceStr === "266") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Tài 14 ra 2-6-6 -> Bẻ Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = `Tài 14 form ${diceStr} -> Giữ Tài`; }
          break;
        case 15:
          if (diceStr === "456") { duDoan = "Xỉu"; doTinCay = "65%"; lyDo = "Tài 15 ra sảnh 4-5-6 -> Bẻ Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = `Tài 15 form ${diceStr} -> Giữ Tài`; }
          break;
        case 16:
          if (diceStr === "556") { duDoan = "Xỉu"; doTinCay = "80%"; lyDo = "Tài 16 ra 5-5-6 -> 80% bẻ Xỉu"; }
          else { duDoan = "Tài"; doTinCay = "55%"; lyDo = `Tài 16 form ${diceStr} -> Giữ Tài`; }
          break;
        case 17: // Tổng 17 chỉ có 1 trường hợp duy nhất là 5-6-6
          duDoan = "Bỏ"; doTinCay = "0%"; lyDo = "Tài 17 (5-6-6) sát nút bão -> Rủi ro, bỏ qua";
          break;
        default:
          duDoan = "Bỏ"; doTinCay = "0%"; lyDo = "Lỗi điểm số";
      }
    }

    res.json({
      id: "tool_cong_thuc_rieng",
      Phien: latestSession.id,
      Phien_du_doan: latestSession.id + 1,
      Xuc_xac: dices.join(' - '),
      Form_sap_xep: diceStr,
      Tong_diem_phien_truoc: tong,
      Ket_qua_phien_truoc: ketQua,
      Du_doan_phien_toi: duDoan,
      Do_tin_cay: doTinCay,
      Chi_tiet_cong_thuc: lyDo
    });

  } catch(err) {
    console.error("API Error: ", err);
    res.status(500).json({ error: "Lỗi hệ thống nội bộ, vui lòng thử lại sau" });
  }
});

app.listen(port, () => console.log(`🚀 API Tool đang chạy tại: http://localhost:${port}/api/taixiu`));
