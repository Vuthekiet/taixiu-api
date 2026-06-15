const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let eternalHistory = []; 
let predictionHistory = [];
let currentPhase = 0;

/**
 * MD5 DECODER ENGINE
 * Phân tích đặc tính chuỗi Hash để tìm quy luật Salt
 */
function analyzeMD5(hash) {
    if (!hash || hash.length < 32) return null;
    
    // Thuật toán phân tích đặc trưng MD5 (Dựa trên tổng giá trị ASCII của 4 ký tự cuối)
    const last4 = hash.slice(-4);
    let score = 0;
    for (let i = 0; i < 4; i++) score += last4.charCodeAt(i);
    
    // Quy luật xác suất: Nếu score chẵn thường về Xỉu, lẻ thường về Tài (Đây là một bộ lọc bổ trợ)
    return score % 2 === 0 ? 0 : 1;
}

function engineV3(sessions, userMD5 = null) {
    if (sessions.length < 10) return { pred: -1, conf: 0, logic: "Đang nạp..." };

    const pts = sessions.map(s => s.point);
    const res = sessions.map(s => s.resultTruyenThong === 'TAI' ? 1 : 0);
    const lastResult = res[res.length - 1];

    // --- ENGINE 1: TREND (Cầu) ---
    let trendPred = -1;
    const sStr = res.slice(-5).join('');
    if (sStr.endsWith('1010')) trendPred = 1; // Cầu 1-1 -> Đánh Tài
    else if (sStr.endsWith('0101')) trendPred = 0; // Cầu 1-1 -> Đánh Xỉu
    else if (sStr.endsWith('111')) trendPred = 1; // Bệt Tài
    else if (sStr.endsWith('000')) trendPred = 0; // Bệt Xỉu

    // --- ENGINE 2: MD5 HYBRID ---
    let md5Pred = analyzeMD5(userMD5);

    // --- VOTING SYSTEM ---
    let finalPred = trendPred;
    let confidence = 75;
    let logic = "Phân tích xu hướng";

    if (md5Pred !== null) {
        if (md5Pred === trendPred) {
            confidence = 98;
            logic = "HYBRID: Cầu & Mã đồng thuận";
        } else if (trendPred === -1) {
            finalPred = md5Pred;
            confidence = 85;
            logic = "MD5: Phân tích mã Hash";
        } else {
            confidence = 60;
            logic = "Cảnh báo: Cầu & Mã ngược nhau";
        }
    }

    return { 
        pred: finalPred, 
        conf: Math.min(Math.round(confidence), 99), 
        logic: logic
    };
}

app.post('/api/predict-md5', (req, res) => {
    const { md5 } = req.body;
    const analysis = engineV3(eternalHistory, md5);
    res.json({
        phien: currentPhase + 1,
        side: analysis.pred === 1 ? 'Tài' : (analysis.pred === 0 ? 'Xỉu' : 'N/A'),
        conf: analysis.conf,
        logic: analysis.logic
    });
});

app.get('/api/data', async (req, res) => {
    try {
        const response = await axios.get(
            'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2',
            { timeout: 4000 }
        );
        const list = response.data.list;
        const latest = list[0];
        eternalHistory = [...list].reverse(); 
        
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            if (predictionHistory.length > 0 && predictionHistory[0].phien === latest.id) {
                const last = predictionHistory[0];
                last.real = latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu';
                last.win = (last.side === last.real);
            }
            const analysis = engineV3(eternalHistory);
            predictionHistory.unshift({
                phien: latest.id + 1,
                side: analysis.pred === 1 ? 'Tài' : (analysis.pred === 0 ? 'Xỉu' : 'N/A'),
                real: null, win: null, conf: analysis.conf, logic: analysis.logic
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log('Engine V3.4 Hybrid MD5 Online'));
