const express = require("express");
const axios = require("axios");
const app = express();
const PORT = process.env.PORT || 3000;

let sessionHistory = [];
let predictionHistory = [];
let currentPhase = 0;

/**
 * THUẬT TOÁN TỐI ƯU HÓA (OPTIMIZED PREDICTOR)
 * Kết hợp EMA, RSI và Pattern Recognition
 */
function predictNextResult(sessions) {
    if (!sessions || sessions.length < 20) {
        return { pred: -1, conf: 50, logic: "Đang thu thập dữ liệu (cần >20 phiên)" };
    }

    const points = sessions.slice(0, 20).map(s => s.point).reverse();
    const results = sessions.slice(0, 20).map(s => s.resultTruyenThong === 'TAI' ? 1 : 0);

    // 1. Tính EMA (Exponential Moving Average) - Chu kỳ 5
    let ema5 = points[0];
    const alpha = 2 / (5 + 1);
    for (let i = 1; i < points.length; i++) {
        ema5 = points[i] * alpha + ema5 * (1 - alpha);
    }

    // 2. Phân tích RSI (Relative Strength Index) cho điểm số
    let gains = 0, losses = 0;
    for (let i = 1; i < points.length; i++) {
        let diff = points[i] - points[i-1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    const avgGain = gains / 19;
    const avgLoss = losses / 19;
    const rs = avgGain / (avgLoss || 1);
    const rsi = 100 - (100 / (1 + rs));

    // 3. Nhận diện Cầu (Pattern Recognition)
    let streak = 1;
    for (let i = 0; i < results.length - 1; i++) {
        if (results[i] === results[i+1]) streak++;
        else break;
    }

    let finalPred = -1;
    let confidence = 50;
    let logic = "";

    // CHIẾN THUẬT QUYẾT ĐỊNH
    if (streak >= 3) {
        finalPred = results[0];
        confidence = 75 + (streak * 2);
        logic = `Cầu bệt ${streak} tay: Đánh thuận`;
    } else if (rsi > 65) {
        finalPred = 0;
        confidence = 65 + (rsi - 65);
        logic = `RSI cao (${rsi.toFixed(1)}): Hồi quy XIU`;
    } else if (rsi < 35) {
        finalPred = 1;
        confidence = 65 + (35 - rsi);
        logic = `RSI thấp (${rsi.toFixed(1)}): Hồi quy TAI`;
    } else {
        finalPred = ema5 > 10.5 ? 0 : 1;
        confidence = 60 + Math.abs(ema5 - 10.5) * 5;
        logic = `EMA (${ema5.toFixed(1)}) hướng về ${finalPred === 1 ? 'TAI' : 'XIU'}`;
    }

    return { 
        pred: finalPred, 
        conf: Math.min(Math.round(confidence), 98), 
        logic: logic 
    };
}

app.get("/api/taixiu", async (req, res) => {
    try {
        const response = await axios.get(
            "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2",
            { timeout: 5000 }
        );
        
        if (!response.data || !response.data.list) throw new Error("Invalid API response");
        
        const sessions = response.data.list;
        const latest = sessions[0];
        
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            
            if (predictionHistory.length > 0) {
                const lastPred = predictionHistory[0];
                if (lastPred.phien === latest.id) {
                    lastPred.ketQua = latest.resultTruyenThong === 'TAI' ? "Tai" : "Xiu";
                    lastPred.dung = (lastPred.duDoan === lastPred.ketQua);
                }
            }

            const prediction = predictNextResult(sessions);
            predictionHistory.unshift({
                phien: latest.id + 1,
                duDoan: prediction.pred === 1 ? "Tai" : (prediction.pred === 0 ? "Xiu" : "N/A"),
                ketQua: null,
                dung: null,
                doTinCay: prediction.conf,
                logic: prediction.logic,
                timestamp: new Date().toISOString()
            });
            
            if (predictionHistory.length > 100) predictionHistory.pop();
        }

        const wins = predictionHistory.filter(p => p.dung === true).length;
        const total = predictionHistory.filter(p => p.dung !== null).length;

        res.json({
            currentPhase: latest.id,
            dices: latest.dices,
            point: latest.point,
            result: latest.resultTruyenThong === 'TAI' ? "Tai" : "Xiu",
            nextPrediction: predictionHistory[0],
            stats: {
                total: total,
                wins: wins,
                winRate: total > 0 ? Math.round((wins / total) * 100) + "%" : "0%"
            },
            history: predictionHistory.slice(0, 10)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Siêu Công Cụ Tài Xỉu MD5</title>
        <meta charset="UTF-8">
        <style>
            body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: white; display: flex; flex-direction: column; align-items: center; padding: 20px; }
            .card { background: #1e293b; border-radius: 15px; padding: 25px; width: 100%; max-width: 600px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; margin-bottom: 20px; }
            .highlight { color: #38bdf8; font-weight: bold; font-size: 24px; }
            .prediction { font-size: 48px; text-align: center; margin: 20px 0; text-transform: uppercase; text-shadow: 0 0 20px rgba(56, 189, 248, 0.5); }
            .tai { color: #4ade80; }
            .xiu { color: #f87171; }
            .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center; }
            .stat-box { background: #0f172a; padding: 10px; border-radius: 10px; }
            .progress-bg { background: #334155; height: 10px; border-radius: 5px; margin: 10px 0; }
            .progress-fill { background: #38bdf8; height: 100%; border-radius: 5px; transition: width 0.5s; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
            th, td { padding: 10px; border-bottom: 1px solid #334155; text-align: left; }
            .win { color: #4ade80; }
            .lose { color: #f87171; }
        </style>
    </head>
    <body>
        <h1>🚀 MD5 PREDICTOR PRO</h1>
        <div class="card">
            <div style="display: flex; justify-content: space-between;">
                <span>Phiên hiện tại: <span id="currentId" class="highlight">-</span></span>
                <span>Kết quả: <span id="currentRes" class="highlight">-</span></span>
            </div>
            <div style="text-align: center; margin-top: 10px;">
                Dices: <span id="dices" style="letter-spacing: 5px; font-size: 20px;">- - -</span>
            </div>
        </div>

        <div class="card" style="border: 2px solid #38bdf8;">
            <h3 style="text-align: center; margin: 0; color: #94a3b8;">DỰ ĐOÁN PHIÊN <span id="nextId">-</span></h3>
            <div id="prediction" class="prediction">-</div>
            <div class="progress-bg"><div id="confBar" class="progress-fill" style="width: 0%"></div></div>
            <div style="display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8;">
                <span>Độ tin cậy: <span id="confText">0%</span></span>
                <span>Logic: <span id="logicText">-</span></span>
            </div>
        </div>

        <div class="card">
            <div class="stats">
                <div class="stat-box"><div>Tổng phiên</div><div id="total" class="highlight">0</div></div>
                <div class="stat-box"><div>Tỉ lệ thắng</div><div id="winRate" class="highlight" style="color: #4ade80;">0%</div></div>
            </div>
            <table id="historyTable">
                <thead><tr><th>Phiên</th><th>Dự đoán</th><th>Kết quả</th><th>Trạng thái</th></tr></thead>
                <tbody></tbody>
            </table>
        </div>

        <script>
            async function update() {
                try {
                    const res = await fetch('/api/taixiu');
                    const data = await res.json();
                    
                    document.getElementById('currentId').innerText = data.currentPhase;
                    document.getElementById('currentRes').innerText = data.result + ' (' + data.point + ')';
                    document.getElementById('dices').innerText = data.dices.join('   ');
                    
                    if (data.nextPrediction) {
                        document.getElementById('nextId').innerText = data.nextPrediction.phien;
                        const predDiv = document.getElementById('prediction');
                        predDiv.innerText = data.nextPrediction.duDoan;
                        predDiv.className = 'prediction ' + (data.nextPrediction.duDoan === 'Tai' ? 'tai' : 'xiu');
                        
                        document.getElementById('confBar').style.width = data.nextPrediction.doTinCay + '%';
                        document.getElementById('confText').innerText = data.nextPrediction.doTinCay + '%';
                        document.getElementById('logicText').innerText = data.nextPrediction.logic;
                    }
                    
                    document.getElementById('total').innerText = data.stats.total;
                    document.getElementById('winRate').innerText = data.stats.winRate;
                    
                    const tbody = document.querySelector('#historyTable tbody');
                    tbody.innerHTML = data.history.map(h => \`
                        <tr>
                            <td>\${h.phien}</td>
                            <td class="\${h.duDoan.toLowerCase()}">\${h.duDoan}</td>
                            <td>\${h.ketQua || '...'}</td>
                            <td class="\${h.dung === true ? 'win' : (h.dung === false ? 'lose' : '')}">
                                \${h.dung === true ? 'THẮNG' : (h.dung === false ? 'THUA' : 'Đang chờ')}
                            </td>
                        </tr>
                    \`).join('');
                } catch (e) {}
            }
            setInterval(update, 3000);
            update();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
});
