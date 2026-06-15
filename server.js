const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

let fullHistory = []; // Lưu trữ tối đa 100 phiên
let predictionHistory = [];
let currentPhase = 0;

/**
 * ENGINE V3.0 - QUANTUM MULTI-STRATEGY
 */
function engineV3(sessions) {
    if (sessions.length < 30) return { pred: -1, conf: 0, logic: "Đang nạp dữ liệu sâu..." };

    const pts = sessions.map(s => s.point).reverse();
    const res = sessions.map(s => s.resultTruyenThong === 'TAI' ? 1 : 0);
    const lastResult = res[res.length - 1];
    const lastPoint = pts[pts.length - 1];

    // --- ENGINE 1: PATTERN RECOGNITION (Tìm kiếm lịch sử) ---
    let patternPred = -1;
    const currentPattern = res.slice(-4).join('');
    let matches = { 1: 0, 0: 0 };
    for (let i = 0; i < res.length - 5; i++) {
        const p = res.slice(i, i + 4).join('');
        if (p === currentPattern) {
            matches[res[i + 4]]++;
        }
    }
    if (matches[1] > matches[0]) patternPred = 1;
    else if (matches[0] > matches[1]) patternPred = 0;

    // --- ENGINE 2: DYNAMIC MOMENTUM (Bắt cầu bệt/đảo) ---
    let momentumPred = -1;
    let streak = 0;
    for (let i = res.length - 1; i >= 0; i--) {
        if (res[i] === lastResult) streak++;
        else break;
    }
    // Nếu bệt >= 3: Đánh thuận (Trend following)
    // Nếu bệt 1-1 liên tiếp >= 4: Đánh đảo (Anti-trend)
    if (streak >= 3) momentumPred = lastResult;
    
    // --- ENGINE 3: MEAN REVERSION (Hồi quy điểm số) ---
    let meanPred = -1;
    const emaShort = calculateEMA(pts, 3);
    const emaLong = calculateEMA(pts, 7);
    if (emaShort > emaLong && lastPoint < 14) meanPred = 1;
    else if (emaShort < emaLong && lastPoint > 7) meanPred = 0;

    // --- HỆ THỐNG TRỌNG SỐ (VOTING SYSTEM) ---
    let votesTai = 0;
    let votesXiu = 0;
    let activeEngines = 0;

    if (patternPred !== -1) { (patternPred === 1 ? votesTai++ : votesXiu++); activeEngines++; }
    if (momentumPred !== -1) { (momentumPred === 1 ? votesTai++ : votesXiu++); activeEngines++; }
    if (meanPred !== -1) { (meanPred === 1 ? votesTai++ : votesXiu++); activeEngines++; }

    let finalPred = -1;
    let confidence = 50;
    
    if (votesTai > votesXiu) {
        finalPred = 1;
        confidence = 60 + (votesTai / activeEngines) * 30;
    } else if (votesXiu > votesTai) {
        finalPred = 0;
        confidence = 60 + (votesXiu / activeEngines) * 30;
    }

    // Đặc biệt: Nếu điểm vừa ra là cực trị (3, 4, 17, 18) -> Tăng mạnh tin cậy hồi quy
    if (lastPoint <= 4) { finalPred = 1; confidence = 95; }
    if (lastPoint >= 17) { finalPred = 0; confidence = 95; }

    return { 
        pred: finalPred, 
        conf: Math.min(Math.round(confidence), 98), 
        logic: activeEngines === 3 ? "Đồng thuận cao" : "Phân tích đa chiều" 
    };
}

function calculateEMA(data, period) {
    let ema = data[0];
    const k = 2 / (period + 1);
    for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
    return ema;
}

app.get('/api/data', async (req, res) => {
    try {
        const response = await axios.get(
            'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2',
            { timeout: 4000 }
        );
        
        const list = response.data.list;
        const latest = list[0];
        
        // Cập nhật bộ nhớ đệm lịch sử
        list.reverse().forEach(s => {
            if (!fullHistory.find(h => h.id === s.id)) {
                fullHistory.push(s);
            }
        });
        if (fullHistory.length > 100) fullHistory = fullHistory.slice(-100);
        
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            
            if (predictionHistory.length > 0 && predictionHistory[0].phien === latest.id) {
                const last = predictionHistory[0];
                last.real = latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu';
                last.win = (last.side === last.real);
            }

            const analysis = engineV3(fullHistory);
            predictionHistory.unshift({
                phien: latest.id + 1,
                side: analysis.pred === 1 ? 'Tài' : (analysis.pred === 0 ? 'Xỉu' : 'N/A'),
                real: null,
                win: null,
                conf: analysis.conf,
                logic: analysis.logic
            });
            if (predictionHistory.length > 50) predictionHistory.pop();
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

app.listen(PORT, () => console.log('Engine V3.0 Online'));
