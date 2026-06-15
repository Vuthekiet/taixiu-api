const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

let fullHistory = []; 
let predictionHistory = [];
let currentPhase = 0;

/**
 * ENGINE V3.1 - HIGH SPEED QUANTUM
 */
function engineV3(sessions) {
    // Với 15 phiên chuẩn từ API, chúng ta đã đủ dữ liệu cơ bản để soi cầu
    if (sessions.length < 10) return { pred: -1, conf: 0, logic: "Đang nạp..." };

    const pts = sessions.map(s => s.point).reverse();
    const res = sessions.map(s => s.resultTruyenThong === 'TAI' ? 1 : 0);
    const lastResult = res[res.length - 1];
    const lastPoint = pts[pts.length - 1];

    // --- ENGINE 1: SMART PATTERN (Dò cầu 1-1, 2-2, 3-3) ---
    let patternPred = -1;
    const tail3 = res.slice(-3).join('');
    // Dò tìm cầu lặp đơn giản
    if (tail3 === '101') patternPred = 0; // Cầu 1-1 -> Đánh Xỉu
    else if (tail3 === '010') patternPred = 1; // Cầu 1-1 -> Đánh Tài
    else if (tail3 === '110') patternPred = 0; // Cầu 2-2 (một nửa) -> Đánh Xỉu
    else if (tail3 === '001') patternPred = 1; // Cầu 2-2 (một nửa) -> Đánh Tài

    // --- ENGINE 2: MOMENTUM (Bắt bệt cực nhanh) ---
    let momentumPred = -1;
    let streak = 0;
    for (let i = res.length - 1; i >= 0; i--) {
        if (res[i] === lastResult) streak++;
        else break;
    }
    if (streak >= 2) momentumPred = lastResult; // Bắt đầu bệt từ tay thứ 3
    
    // --- ENGINE 3: VOLATILITY (Biến động điểm số) ---
    let volPred = -1;
    const avg = pts.slice(-5).reduce((a, b) => a + b, 0) / 5;
    if (avg < 9) volPred = 1; // Điểm trung bình thấp -> Hồi Tài
    else if (avg > 12) volPred = 0; // Điểm trung bình cao -> Hồi Xỉu

    // --- VOTING SYSTEM ---
    let votesTai = 0, votesXiu = 0, active = 0;
    if (patternPred !== -1) { (patternPred === 1 ? votesTai++ : votesXiu++); active++; }
    if (momentumPred !== -1) { (momentumPred === 1 ? votesTai++ : votesXiu++); active++; }
    if (volPred !== -1) { (volPred === 1 ? votesTai++ : votesXiu++); active++; }

    let finalPred = -1, confidence = 50;
    if (votesTai > votesXiu) {
        finalPred = 1;
        confidence = 65 + (votesTai / (active || 1)) * 25;
    } else if (votesXiu > votesTai) {
        finalPred = 0;
        confidence = 65 + (votesXiu / (active || 1)) * 25;
    }

    // Chốt chặn cực trị
    if (lastPoint <= 5) { finalPred = 1; confidence = 95; }
    if (lastPoint >= 16) { finalPred = 0; confidence = 95; }

    return { 
        pred: finalPred, 
        conf: Math.min(Math.round(confidence), 98), 
        logic: streak >= 3 ? "Bắt cầu bệt" : (active >= 2 ? "Phân tích cầu" : "Theo xu hướng")
    };
}

app.get('/api/data', async (req, res) => {
    try {
        const response = await axios.get(
            'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2',
            { timeout: 4000 }
        );
        
        const list = response.data.list; // API trả về 15 phiên mới nhất
        const latest = list[0];
        
        // Cập nhật lịch sử: Luôn đồng bộ với 15 phiên mới nhất từ API
        fullHistory = [...list].reverse(); 
        
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            
            if (predictionHistory.length > 0 && predictionHistory[0].phien === latest.id) {
                const last = predictionHistory[0];
                last.real = latest.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu';
                last.win = (last.side === last.real);
            }

            const analysis = engineV3(list);
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

app.listen(PORT, () => console.log('Engine V3.1 High-Speed Online'));
