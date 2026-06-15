const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Cấu hình phục vụ file tĩnh từ thư mục hiện tại
app.use(express.static(__dirname));

let predictionHistory = [];
let currentPhase = 0;

/**
 * CORE LOGIC: Phân tích xu hướng dựa trên 3 chỉ số chính
 */
function analyze(sessions) {
    if (!sessions || sessions.length < 15) return { pred: -1, conf: 0, logic: "Nạp dữ liệu..." };

    const pts = sessions.slice(0, 15).map(s => s.point).reverse();
    const res = sessions.slice(0, 15).map(s => s.resultTruyenThong === 'TAI' ? 1 : 0);

    // 1. EMA (Short-term trend)
    let ema = pts[0];
    const k = 2 / (5 + 1);
    for (let i = 1; i < pts.length; i++) ema = pts[i] * k + ema * (1 - k);

    // 2. Momentum (Xác định bệt/đảo)
    let streak = 1;
    for (let i = 0; i < res.length - 1; i++) {
        if (res[i] === res[i+1]) streak++;
        else break;
    }

    let p = -1, c = 50, l = "";

    if (streak >= 3) {
        p = res[0]; // Theo bệt
        c = 70 + (streak * 5);
        l = "Bệt " + streak + " tay";
    } else {
        p = ema > 10.5 ? 0 : 1; // Hồi quy
        c = 65 + Math.abs(ema - 10.5) * 6;
        l = "EMA " + ema.toFixed(1);
    }

    return { pred: p, conf: Math.min(Math.round(c), 95), logic: l };
}

app.get('/api/data', async (req, res) => {
    try {
        const response = await axios.get(
            'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2',
            { timeout: 4000 }
        );
        
        const list = response.data.list;
        const latest = list[0];
        
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            
            if (predictionHistory.length > 0 && predictionHistory[0].phien === latest.id) {
                const last = predictionHistory[0];
                last.real = latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu';
                last.win = (last.side === last.real);
            }

            const analysis = analyze(list);
            predictionHistory.unshift({
                phien: latest.id + 1,
                side: analysis.pred === 1 ? 'Tài' : (analysis.pred === 0 ? 'Xỉu' : 'N/A'),
                real: null,
                win: null,
                conf: analysis.conf,
                logic: analysis.logic
            });
            if (predictionHistory.length > 20) predictionHistory.pop();
        }

        const wins = predictionHistory.filter(h => h.win === true).length;
        const played = predictionHistory.filter(h => h.win !== null).length;

        res.json({
            current: { id: latest.id, dices: latest.dices, point: latest.point, side: latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu' },
            next: predictionHistory[0],
            stats: { winRate: played > 0 ? Math.round((wins / played) * 100) : 0, played },
            history: predictionHistory.slice(1, 11)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Route chính trả về giao diện
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
const path = require('path');
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html')); // Hãy đổi 'index.html' thành tên file HTML của bạn nếu đặt tên khác
});

app.listen(PORT, () => console.log('Server is running...'));
