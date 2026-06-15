const express = require("express");
const axios = require("axios");
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// BỘ NHỚ TOÀN CỤC
// ==========================================
let sessionHistory = [];
let predictionHistory = [];
let currentPhase = 0;

// ==========================================
// THUẬT TOÁN DỰ ĐOÁN 4 THÀNH PHẦN (OPTIMIZED)
// ==========================================

/**
 * Phân tích Gaussian Noise Filter
 * Tính độ lệch chuẩn của 15 ván gần nhất
 * Nếu stdDev quá thấp -> Điểm quá ổn định -> Sẽ gãy nhịp
 * Nếu stdDev quá cao -> Điểm quá biến động -> Sẽ hồi quy
 */
function gaussianNoiseFilter(sessions) {
    if (sessions.length < 15) return -1;
    
    const points = sessions.slice(0, 15).map(s => s.point);
    const mean = points.reduce((a, b) => a + b, 0) / 15;
    const variance = points.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 15;
    const stdDev = Math.sqrt(variance);
    
    // Nếu độ lệch chuẩn quá thấp (< 1.2) -> Điểm quá ổn định
    if (stdDev < 1.2) {
        const lastResult = sessions[0].resultTruyenThong === 'TAI' ? 1 : 0;
        return lastResult === 1 ? 0 : 1; // Đảo chiều
    }
    
    // Nếu độ lệch chuẩn quá cao (> 5.5) -> Điểm quá biến động
    if (stdDev > 5.5) {
        if (mean > 13.5) return 0; // Điểm cao -> Xỉu
        if (mean < 7.5) return 1; // Điểm thấp -> Tài
    }
    
    return -1;
}

/**
 * Phân tích Point Velocity (Vận tốc Điểm rơi)
 * Tính tốc độ thay đổi điểm giữa các phiên
 * Nếu tốc độ quá cao -> Sẽ hồi quy về mức cân bằng
 */
function pointVelocity(sessions) {
    if (sessions.length < 8) return -1;
    
    let velocity = 0;
    let direction = 0;
    
    for (let i = 0; i < 7; i++) {
        const diff = sessions[i].point - sessions[i+1].point;
        velocity += Math.abs(diff);
        if (i === 0) direction = diff > 0 ? 1 : -1;
    }
    
    const avgVelocity = velocity / 7;
    
    // Nếu vận tốc quá cao (> 2.5) -> Sẽ hồi quy
    if (avgVelocity > 2.5) {
        return direction > 0 ? 0 : 1; // Đảo chiều
    }
    
    return -1;
}

/**
 * Phân tích Dice Fall (Chuỗi Điểm Đơn điệu)
 * Nếu chuỗi điểm quá đơn điệu (tăng hoặc giảm liên tục) -> Sẽ gãy nhịp
 */
function diceFallAnalysis(sessions) {
    if (sessions.length < 10) return -1;
    
    const points = sessions.slice(0, 10).map(s => s.point);
    let monotonic = true;
    let direction = 0;
    
    for (let i = 0; i < 9; i++) {
        const diff = points[i] - points[i+1];
        if (i === 0) direction = diff > 0 ? 1 : -1;
        if ((diff > 0 && direction < 0) || (diff < 0 && direction > 0)) {
            monotonic = false;
            break;
        }
    }
    
    if (monotonic && direction !== 0) {
        const lastResult = sessions[0].resultTruyenThong === 'TAI' ? 1 : 0;
        return lastResult === 1 ? 0 : 1; // Đảo chiều
    }
    
    return -1;
}

/**
 * Phân tích Markov Chain (Nhận diện Pattern)
 * Tìm mẫu hình 3 ván gần nhất lặp lại trong lịch sử
 * Dự đoán dựa trên kết quả ván tiếp theo sau mẫu hình đó
 */
function markovChainPattern(sessions) {
    if (sessions.length < 20) return -1;
    
    const pattern = "" + 
        (sessions[0].resultTruyenThong === 'TAI' ? '1' : '0') +
        (sessions[1].resultTruyenThong === 'TAI' ? '1' : '0') +
        (sessions[2].resultTruyenThong === 'TAI' ? '1' : '0');
    
    let matches = { tai: 0, xiu: 0 };
    
    for (let i = 3; i < sessions.length - 3; i++) {
        const checkPattern = "" +
            (sessions[i].resultTruyenThong === 'TAI' ? '1' : '0') +
            (sessions[i+1].resultTruyenThong === 'TAI' ? '1' : '0') +
            (sessions[i+2].resultTruyenThong === 'TAI' ? '1' : '0');
        
        if (checkPattern === pattern && i + 3 < sessions.length) {
            if (sessions[i+3].resultTruyenThong === 'TAI') {
                matches.tai++;
            } else {
                matches.xiu++;
            }
        }
    }
    
    if (matches.tai > matches.xiu && matches.tai >= 2) return 1;
    if (matches.xiu > matches.tai && matches.xiu >= 2) return 0;
    
    return -1;
}

/**
 * Thuật toán dự đoán tổng hợp
 */
function predictNextResult(sessions) {
    if (!sessions || sessions.length < 20) {
        return { pred: -1, conf: 50, logic: "Chưa đủ dữ liệu" };
    }
    
    let predictions = [];
    let confidences = [];
    let logics = [];
    
    // 1. Gaussian Noise Filter
    const gaussPred = gaussianNoiseFilter(sessions);
    if (gaussPred !== -1) {
        predictions.push(gaussPred);
        confidences.push(88);
        logics.push("GAUSSIAN: Độ lệch chuẩn điểm");
    }
    
    // 2. Point Velocity
    const velPred = pointVelocity(sessions);
    if (velPred !== -1) {
        predictions.push(velPred);
        confidences.push(85);
        logics.push("VELOCITY: Vận tốc điểm rơi");
    }
    
    // 3. Dice Fall Analysis
    const dicePred = diceFallAnalysis(sessions);
    if (dicePred !== -1) {
        predictions.push(dicePred);
        confidences.push(87);
        logics.push("DICE FALL: Chuỗi điểm đơn điệu");
    }
    
    // 4. Markov Chain
    const markovPred = markovChainPattern(sessions);
    if (markovPred !== -1) {
        predictions.push(markovPred);
        confidences.push(84);
        logics.push("MARKOV: Nhận diện pattern");
    }
    
    // Nếu có dự đoán
    if (predictions.length > 0) {
        // Tính dự đoán đa số
        const taiCount = predictions.filter(p => p === 1).length;
        const xiuCount = predictions.filter(p => p === 0).length;
        const finalPred = taiCount > xiuCount ? 1 : 0;
        
        // Tính độ tin cậy trung bình
        const avgConf = Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length);
        
        // Lấy logic của dự đoán có độ tin cậy cao nhất
        const maxConfIdx = confidences.indexOf(Math.max(...confidences));
        const logic = logics[maxConfIdx];
        
        return { pred: finalPred, conf: avgConf, logic };
    }
    
    // Mặc định
    return { pred: -1, conf: 50, logic: "Không có dự đoán" };
}

// ==========================================
// API ENDPOINTS
// ==========================================
app.get("/api/taixiu", async (req, res) => {
    try {
        const response = await axios.get(
            "https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web&at=910a2c78e3eb1137d7ef50c8ddea98d2",
            { timeout: 5000 }
        );
        
        if (!response.data?.list) throw new Error("Invalid API response");
        
        const sessions = response.data.list;
        const latest = sessions[0];
        
        // Cập nhật lịch sử phiên
        if (currentPhase !== latest.id) {
            currentPhase = latest.id;
            sessionHistory.unshift(latest);
            sessionHistory = sessionHistory.slice(0, 100);
            
            // Dự đoán phiên tiếp theo
            const prediction = predictNextResult(sessions);
            predictionHistory.unshift({
                phien: latest.id,
                duDoan: prediction.pred === 1 ? "Tài" : "Xỉu",
                ketQua: latest.resultTruyenThong === 'TAI' ? "Tài" : "Xỉu",
                dung: (prediction.pred === 1 && latest.resultTruyenThong === 'TAI') ||
                      (prediction.pred === 0 && latest.resultTruyenThong === 'XIU'),
                doTinCay: prediction.conf,
                logic: prediction.logic,
                timestamp: new Date().toISOString()
            });
            predictionHistory = predictionHistory.slice(0, 100);
        }
        
        // Tính thống kê
        const recent10 = predictionHistory.slice(0, 10);
        const recent20 = predictionHistory.slice(0, 20);
        const win10 = recent10.filter(p => p.dung).length;
        const win20 = recent20.filter(p => p.dung).length;
        
        res.json({
            currentPhase: latest.id,
            dices: latest.dices,
            point: latest.point,
            result: latest.resultTruyenThong === 'TAI' ? "Tài" : "Xỉu",
            nextPrediction: predictionHistory[0] || null,
            predictionHistory: predictionHistory.slice(0, 20),
            stats: {
                total: predictionHistory.length,
                wins: predictionHistory.filter(p => p.dung).length,
                winRate10: `${Math.round((win10 / Math.max(recent10.length, 1)) * 100)}%`,
                winRate20: `${Math.round((win20 / Math.max(recent20.length, 1)) * 100)}%`
            }
        });
    } catch (error) {
        console.error("API Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// GIAO DIỆN DASHBOARD (HTML INLINE)
// ==========================================
app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tài Xỉu Predictor Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #0a0e19 0%, #1a1f3a 100%);
            color: #fff;
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        header {
            text-align: center;
            margin-bottom: 30px;
            padding: 20px;
            background: rgba(0, 255, 136, 0.1);
            border: 2px solid #00ff88;
            border-radius: 12px;
            box-shadow: 0 0 20px rgba(0, 255, 136, 0.3);
        }
        
        header h1 {
            font-size: 32px;
            color: #00ff88;
            text-shadow: 0 0 10px #00ff88;
            margin-bottom: 5px;
        }
        
        header p {
            color: #aaa;
            font-size: 14px;
        }
        
        .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 30px;
        }
        
        @media (max-width: 1024px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
        
        .card {
            background: rgba(20, 25, 40, 0.8);
            border: 2px solid rgba(0, 255, 136, 0.3);
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 0 20px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
        }
        
        .card.current {
            border-color: #00ff88;
            box-shadow: 0 0 30px rgba(0, 255, 136, 0.4);
        }
        
        .card.prediction {
            border-color: #ffd966;
            box-shadow: 0 0 30px rgba(255, 217, 102, 0.4);
        }
        
        .card h2 {
            font-size: 18px;
            color: #00ff88;
            margin-bottom: 15px;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        
        .phase-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding: 10px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
        }
        
        .phase-label {
            color: #aaa;
            font-size: 12px;
        }
        
        .phase-value {
            font-size: 20px;
            font-weight: bold;
            color: #00ff88;
        }
        
        .dices-display {
            display: flex;
            justify-content: center;
            gap: 15px;
            margin: 20px 0;
        }
        
        .dice {
            width: 60px;
            height: 60px;
            background: linear-gradient(135deg, #1a1f3a, #0a0e19);
            border: 2px solid #00ff88;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 28px;
            font-weight: bold;
            color: #00ff88;
            box-shadow: 0 0 15px rgba(0, 255, 136, 0.3);
        }
        
        .point-display {
            text-align: center;
            padding: 15px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            margin: 15px 0;
        }
        
        .point-label {
            color: #aaa;
            font-size: 12px;
            margin-bottom: 5px;
        }
        
        .point-value {
            font-size: 32px;
            font-weight: bold;
            color: #ffd966;
        }
        
        .result-display {
            display: flex;
            gap: 10px;
            margin: 15px 0;
        }
        
        .result-btn {
            flex: 1;
            padding: 15px;
            border: 2px solid;
            border-radius: 8px;
            font-size: 18px;
            font-weight: bold;
            cursor: default;
            text-transform: uppercase;
            letter-spacing: 2px;
        }
        
        .result-btn.tai {
            border-color: #00ff88;
            background: rgba(0, 255, 136, 0.1);
            color: #00ff88;
            box-shadow: 0 0 15px rgba(0, 255, 136, 0.3);
        }
        
        .result-btn.xiu {
            border-color: #ff4466;
            background: rgba(255, 68, 102, 0.1);
            color: #ff4466;
            box-shadow: 0 0 15px rgba(255, 68, 102, 0.3);
        }
        
        .result-btn.active {
            box-shadow: 0 0 25px currentColor;
        }
        
        .prediction-result {
            text-align: center;
            padding: 20px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            margin: 15px 0;
        }
        
        .prediction-value {
            font-size: 36px;
            font-weight: bold;
            margin: 10px 0;
            text-transform: uppercase;
            letter-spacing: 3px;
        }
        
        .prediction-value.tai {
            color: #00ff88;
            text-shadow: 0 0 15px #00ff88;
        }
        
        .prediction-value.xiu {
            color: #ff4466;
            text-shadow: 0 0 15px #ff4466;
        }
        
        .confidence-bar {
            margin: 15px 0;
        }
        
        .confidence-label {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            font-size: 12px;
            color: #aaa;
        }
        
        .progress-bar {
            width: 100%;
            height: 8px;
            background: rgba(0, 0, 0, 0.5);
            border-radius: 4px;
            overflow: hidden;
            border: 1px solid rgba(0, 255, 136, 0.2);
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #00ff88, #ffd966);
            box-shadow: 0 0 10px rgba(0, 255, 136, 0.5);
            transition: width 0.3s ease;
        }
        
        .logic-info {
            padding: 10px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            font-size: 12px;
            color: #aaa;
            margin-top: 10px;
            border-left: 3px solid #ffd966;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-top: 20px;
        }
        
        @media (max-width: 768px) {
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
        
        .stat-box {
            background: rgba(0, 0, 0, 0.3);
            border: 1px solid rgba(0, 255, 136, 0.2);
            border-radius: 8px;
            padding: 12px;
            text-align: center;
        }
        
        .stat-label {
            font-size: 11px;
            color: #aaa;
            margin-bottom: 5px;
        }
        
        .stat-value {
            font-size: 18px;
            font-weight: bold;
            color: #00ff88;
        }
        
        .history-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            overflow-x: auto;
        }
        
        .history-table th {
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid rgba(0, 255, 136, 0.2);
            padding: 10px;
            text-align: left;
            font-size: 12px;
            color: #00ff88;
            text-transform: uppercase;
        }
        
        .history-table td {
            border: 1px solid rgba(0, 255, 136, 0.1);
            padding: 10px;
            font-size: 12px;
        }
        
        .history-table tr:hover {
            background: rgba(0, 255, 136, 0.05);
        }
        
        .status-win {
            color: #00ff88;
            font-weight: bold;
        }
        
        .status-lose {
            color: #ff4466;
            font-weight: bold;
        }
        
        .status-icon {
            margin-right: 5px;
        }
        
        .loading {
            text-align: center;
            padding: 20px;
            color: #aaa;
        }
        
        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 3px solid rgba(0, 255, 136, 0.3);
            border-top-color: #00ff88;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
        
        .update-time {
            text-align: center;
            margin-top: 20px;
            font-size: 12px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>🎲 TÀI XỈU PREDICTOR</h1>
            <p>Dashboard Dự Đoán Real-Time | Thuật Toán 4 Thành Phần</p>
        </header>
        
        <div class="grid">
            <!-- PHIÊN HIỆN TẠI -->
            <div class="card current">
                <h2>📊 Phiên Hiện Tại</h2>
                <div class="phase-info">
                    <span class="phase-label">Phiên #</span>
                    <span class="phase-value" id="currentPhase">-</span>
                </div>
                
                <div class="dices-display" id="dicesDisplay">
                    <div class="dice">-</div>
                    <div class="dice">-</div>
                    <div class="dice">-</div>
                </div>
                
                <div class="point-display">
                    <div class="point-label">Tổng Điểm</div>
                    <div class="point-value" id="pointValue">-</div>
                </div>
                
                <div class="result-display">
                    <div class="result-btn tai" id="resultTai">Tài</div>
                    <div class="result-btn xiu" id="resultXiu">Xỉu</div>
                </div>
            </div>
            
            <!-- DỰ ĐOÁN PHIÊN TIẾP THEO -->
            <div class="card prediction">
                <h2>🔮 Dự Đoán Phiên Tiếp Theo</h2>
                
                <div class="prediction-result">
                    <div style="font-size: 12px; color: #aaa; margin-bottom: 10px;">KẾT QUẢ DỰ ĐOÁN</div>
                    <div class="prediction-value" id="predictionValue">-</div>
                </div>
                
                <div class="confidence-bar">
                    <div class="confidence-label">
                        <span>Độ Tin Cậy</span>
                        <span id="confidencePercent">0%</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progressFill" style="width: 0%"></div>
                    </div>
                </div>
                
                <div class="logic-info" id="logicInfo">
                    Đang tải dữ liệu...
                </div>
                
                <div class="stats-grid">
                    <div class="stat-box">
                        <div class="stat-label">Tổng Phiên</div>
                        <div class="stat-value" id="totalPhases">0</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Thắng</div>
                        <div class="stat-value" id="winCount">0</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">WinRate 10</div>
                        <div class="stat-value" id="winRate10">0%</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">WinRate 20</div>
                        <div class="stat-value" id="winRate20">0%</div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- LỊCH SỬ DỰ ĐOÁN -->
        <div class="card">
            <h2>📈 Lịch Sử Dự Đoán (20 Phiên Gần Nhất)</h2>
            <div id="historyContainer" class="loading">
                <div class="spinner"></div> Đang tải dữ liệu...
            </div>
        </div>
        
        <div class="update-time">
            Cập nhật tự động mỗi 3 giây | Lần cập nhật cuối: <span id="lastUpdate">-</span>
        </div>
    </div>
    
    <script>
        async function updateDashboard() {
            try {
                const response = await fetch('/api/taixiu');
                const data = await response.json();
                
                // Cập nhật phiên hiện tại
                document.getElementById('currentPhase').textContent = data.currentPhase;
                
                // Cập nhật xúc xắc
                const dicesDisplay = document.getElementById('dicesDisplay');
                dicesDisplay.innerHTML = data.dices
                    .map(d => \`<div class="dice">\${d}</div>\`)
                    .join('');
                
                // Cập nhật điểm
                document.getElementById('pointValue').textContent = data.point;
                
                // Cập nhật kết quả
                const resultTai = document.getElementById('resultTai');
                const resultXiu = document.getElementById('resultXiu');
                resultTai.classList.remove('active');
                resultXiu.classList.remove('active');
                if (data.result === 'Tài') {
                    resultTai.classList.add('active');
                } else {
                    resultXiu.classList.add('active');
                }
                
                // Cập nhật dự đoán
                if (data.nextPrediction) {
                    const predValue = document.getElementById('predictionValue');
                    predValue.textContent = data.nextPrediction.duDoan;
                    predValue.className = 'prediction-value ' + (data.nextPrediction.duDoan === 'Tài' ? 'tai' : 'xiu');
                    
                    document.getElementById('confidencePercent').textContent = data.nextPrediction.doTinCay + '%';
                    document.getElementById('progressFill').style.width = data.nextPrediction.doTinCay + '%';
                    document.getElementById('logicInfo').textContent = '🔧 ' + data.nextPrediction.logic;
                }
                
                // Cập nhật thống kê
                document.getElementById('totalPhases').textContent = data.stats.total;
                document.getElementById('winCount').textContent = data.stats.wins;
                document.getElementById('winRate10').textContent = data.stats.winRate10;
                document.getElementById('winRate20').textContent = data.stats.winRate20;
                
                // Cập nhật lịch sử
                const historyContainer = document.getElementById('historyContainer');
                if (data.predictionHistory.length > 0) {
                    let html = \`
                        <table class="history-table">
                            <thead>
                                <tr>
                                    <th>Phiên</th>
                                    <th>Dự Đoán</th>
                                    <th>Kết Quả</th>
                                    <th>Kết Luận</th>
                                    <th>Độ Tin Cậy</th>
                                    <th>Logic</th>
                                </tr>
                            </thead>
                            <tbody>
                    \`;
                    
                    data.predictionHistory.forEach(pred => {
                        const statusClass = pred.dung ? 'status-win' : 'status-lose';
                        const statusText = pred.dung ? '✓ THẮNG' : '✗ THUA';
                        html += \`
                            <tr>
                                <td>#\${pred.phien}</td>
                                <td>\${pred.duDoan}</td>
                                <td>\${pred.ketQua}</td>
                                <td class="\${statusClass}">\${statusText}</td>
                                <td>\${pred.doTinCay}%</td>
                                <td style="font-size: 11px; color: #aaa;">\${pred.logic}</td>
                            </tr>
                        \`;
                    });
                    
                    html += \`
                            </tbody>
                        </table>
                    \`;
                    
                    historyContainer.innerHTML = html;
                }
                
                // Cập nhật thời gian
                document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('vi-VN');
                
            } catch (error) {
                console.error('Error:', error);
            }
        }
        
        // Cập nhật lần đầu
        updateDashboard();
        
        // Cập nhật mỗi 3 giây
        setInterval(updateDashboard, 3000);
    </script>
</body>
</html>
    `);
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => {
    console.log(`✅ Tài Xỉu Predictor Dashboard running on port ${PORT}`);
});
