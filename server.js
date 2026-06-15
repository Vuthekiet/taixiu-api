const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let diceHistory = []; 
let predictionHistory = [];
let currentPhase = 0;

/**
 * ENGINE V4.0 - DICE PHYSICS & MD5 HYBRID
 * Loại bỏ soi cầu, tập trung vào xác suất điểm số 3 viên xúc xắc
 */
function analyzeDicePhysics(sessions, userMD5 = null) {
    if (sessions.length < 5) return { pred: -1, conf: 0, logic: "Đang nạp dữ liệu..." };

    const latest = sessions[sessions.length - 1];
    const dices = latest.dices; // [v1, v2, v3]
    const point = latest.point;

    // --- LOGIC 1: DICE CORRELATION (Tương quan điểm số) ---
    let dicePred = -1;
    let diceConf = 0;
    
    // Quy luật bù trừ (Law of Large Numbers)
    // Nếu phiên trước có mặt 6 xuất hiện nhiều -> Phiên sau xu hướng về Xỉu cao hơn
    const count6 = dices.filter(v => v === 6).length;
    const count1 = dices.filter(v => v === 1).length;
    
    if (count6 >= 2) { dicePred = 0; diceConf = 85; } // 2 con 6 -> Khả năng cao hồi Xỉu
    else if (count1 >= 2) { dicePred = 1; diceConf = 85; } // 2 con 1 -> Khả năng cao hồi Tài
    
    // Logic điểm cực trị
    if (point <= 5) { dicePred = 1; diceConf = 95; }
    else if (point >= 16) { dicePred = 0; diceConf = 95; }

    // --- LOGIC 2: MD5 DECODER ---
    let md5Pred = -1;
    if (userMD5 && userMD5.length >= 32) {
        const last4 = userMD5.slice(-4);
        let sum = 0;
        for (let i = 0; i < 4; i++) sum += last4.charCodeAt(i);
        md5Pred = sum % 2 === 0 ? 0 : 1;
    }

    // --- HYBRID DECISION ---
    let finalPred = dicePred;
    let finalConf = diceConf || 70;
    let logic = "Phân tích điểm xúc xắc";

    if (md5Pred !== -1) {
        if (md5Pred === dicePred) {
            finalConf = 98;
            logic = "ĐỒNG THUẬN: Điểm & Mã Hash";
        } else if (dicePred === -1) {
            finalPred = md5Pred;
            finalConf = 88;
            logic = "MD5: Giải mã mã Hash";
        } else {
            finalConf = 55;
            logic = "CẢNH BÁO: Điểm & Mã ngược nhau";
        }
    }

    return { pred: finalPred, conf: finalConf, logic: logic };
}

app.post('/api/predict-md5', (req, res) => {
    const { md5 } = req.body;
    const analysis = analyzeDicePhysics(diceHistory, md5);
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
        diceHistory = [...list].reverse();
        
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            if (predictionHistory.length > 0 && predictionHistory[0].phien === latest.id) {
                const last = predictionHistory[0];
                last.real = latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu';
                last.win = (last.side === last.real);
            }
            const analysis = analyzeDicePhysics(diceHistory);
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

app.listen(PORT, () => console.log('Engine V4.0 Dice Analytics Online'));
