// ===== 貪吃蛇 Snake Game (p5.js + p5.sound) =====
// 操作：方向鍵 或 WASD 移動，空白鍵 暫停 / 重新開始，M 靜音
// 結束後若分數進入前 10 名，可輸入名字登上排行榜
// 排行榜存在 Firebase Firestore（firebase-config.js 沒填時改存瀏覽器 localStorage）

const CELL = 20;        // 每一格的大小（像素）
const COLS = 20;        // 橫向格數
const ROWS = 20;        // 縱向格數
const BOARD_SIZE = 10;  // 排行榜保留幾名
const STORAGE_KEY = "snake-leaderboard";

let cnv;
let snake;              // 蛇身體：陣列，第 0 個是頭
let dir;                // 目前方向
let nextDir;            // 下一步方向（避免一幀內連按造成自撞）
let food;               // 食物位置
let score;
let state;              // "start" | "play" | "pause" | "checking" | "enterName" | "saving" | "over"
let speed;              // 每秒移動幾格

let leaderboard = [];   // [{ id, name, score }]
let lastRank = -1;      // 這局在排行榜上的名次（用來高亮）
let nameInput;          // 輸入名字的輸入框
let db = null;          // Firestore 資料庫；null 表示用 localStorage
let boardError = "";    // 雲端讀寫失敗時顯示的訊息

// ===== 音效 =====
let sfx;                // { osc, env } 合成器
let muted = false;

function setup() {
  cnv = createCanvas(COLS * CELL, ROWS * CELL + 40); // 下方 40px 顯示分數
  textFont("monospace");
  initFirebase();
  loadLeaderboard();
  setupSound();
  setupNameInput();
  resetGame();
  state = "start";
}

function resetGame() {
  const cx = floor(COLS / 2);
  const cy = floor(ROWS / 2);
  snake = [
    createVector(cx, cy),
    createVector(cx - 1, cy),
    createVector(cx - 2, cy),
  ];
  dir = createVector(1, 0);
  nextDir = dir.copy();
  score = 0;
  speed = 8;
  lastRank = -1;
  frameRate(speed);
  placeFood();
}

function placeFood() {
  // 隨機找一個不在蛇身上的位置
  let pos;
  do {
    pos = createVector(floor(random(COLS)), floor(random(ROWS)));
  } while (snake.some((s) => s.x === pos.x && s.y === pos.y));
  food = pos;
}

function draw() {
  background(24, 26, 32);
  drawGrid();

  if (state === "play") {
    update();
  }

  drawFood();
  drawSnake();
  drawHUD();

  if (state === "start") {
    drawMessage("貪吃蛇", "按 空白鍵 或 方向鍵 開始");
  } else if (state === "pause") {
    drawMessage("暫停", "按 空白鍵 繼續");
  } else if (state === "checking") {
    drawMessage("遊戲結束", "讀取排行榜中…");
  } else if (state === "enterName") {
    drawNameEntry();
  } else if (state === "saving") {
    drawMessage("儲存中…", "正在上傳到排行榜");
  } else if (state === "over") {
    drawLeaderboard();
  }
}

function update() {
  dir = nextDir.copy();
  const head = snake[0].copy().add(dir);

  // 撞牆
  if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
    gameOver();
    return;
  }

  // 吃到食物？
  const ate = head.x === food.x && head.y === food.y;

  // 撞到自己（沒吃東西時尾巴會移走，所以不檢查最後一節）
  const body = ate ? snake : snake.slice(0, -1);
  if (body.some((s) => s.x === head.x && s.y === head.y)) {
    gameOver();
    return;
  }

  snake.unshift(head);
  if (ate) {
    score++;
    if (score % 5 === 0) {
      speed = min(speed + 1, 20); // 每吃 5 個加速
      frameRate(speed);
      sfxLevelUp();
    } else {
      sfxEat();
    }
    if (snake.length === COLS * ROWS) {
      gameOver(); // 填滿整個場地 = 勝利
      return;
    }
    placeFood();
  } else {
    snake.pop();
  }
}

function gameOver() {
  sfxGameOver();
  frameRate(30); // 結束畫面用正常速度，讓動畫和輸入更順
  state = "checking";
  // 先抓最新的排行榜（別人可能剛刷新紀錄），再決定能不能上榜
  loadLeaderboard().then(() => {
    if (qualifies(score)) {
      state = "enterName";
      showNameInput();
    } else {
      state = "over";
    }
  });
}

// ===== 排行榜（Firebase Firestore，沒設定時用 localStorage） =====

function initFirebase() {
  const configured =
    typeof firebase !== "undefined" &&
    typeof firebaseConfig !== "undefined" &&
    firebaseConfig.apiKey &&
    firebaseConfig.projectId;
  if (!configured) {
    console.warn("Firebase 未設定，排行榜改存在本機 localStorage");
    return;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  } catch (e) {
    console.error("Firebase 初始化失敗：", e);
    db = null;
  }
}

// 讀取前 10 名，回傳 Promise
async function loadLeaderboard() {
  if (!db) {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(data)) leaderboard = data;
    } catch (e) {
      leaderboard = [];
    }
    return;
  }
  try {
    const snap = await db
      .collection("scores")
      .orderBy("score", "desc")
      .limit(BOARD_SIZE)
      .get();
    leaderboard = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    boardError = "";
  } catch (e) {
    console.error("讀取排行榜失敗：", e);
    boardError = "無法連線到雲端排行榜";
  }
}

function qualifies(s) {
  if (s <= 0) return false;
  if (leaderboard.length < BOARD_SIZE) return true;
  return s > leaderboard[leaderboard.length - 1].score;
}

// 新增一筆分數，回傳 Promise
async function addToLeaderboard(name, s) {
  if (!db) {
    const entry = { name, score: s };
    leaderboard.push(entry);
    // 分數高的在前；同分時先登記的在前（sort 是穩定排序）
    leaderboard.sort((a, b) => b.score - a.score);
    leaderboard = leaderboard.slice(0, BOARD_SIZE);
    lastRank = leaderboard.indexOf(entry);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(leaderboard));
    } catch (e) {
      // 無法存（例如無痕模式），本次遊玩期間仍然有效
    }
    return;
  }
  try {
    const ref = await db.collection("scores").add({
      name,
      score: s,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await loadLeaderboard();
    lastRank = leaderboard.findIndex((e) => e.id === ref.id);
  } catch (e) {
    console.error("上傳分數失敗：", e);
    boardError = "分數上傳失敗";
  }
}

function highScore() {
  return leaderboard.length ? max(leaderboard[0].score, score) : score;
}

// ===== 名字輸入框（用 DOM input，才能輸入中文） =====

function setupNameInput() {
  nameInput = createInput("");
  nameInput.attribute("maxlength", "12");
  nameInput.attribute("placeholder", "輸入名字");
  nameInput.style("font-size", "18px");
  nameInput.style("font-family", "monospace");
  nameInput.style("text-align", "center");
  nameInput.style("width", "180px");
  nameInput.style("padding", "6px");
  nameInput.style("border", "2px solid #78e678");
  nameInput.style("border-radius", "6px");
  nameInput.style("background", "#181a20");
  nameInput.style("color", "#fff");
  nameInput.style("outline", "none");
  nameInput.hide();

  // 按 Enter 送出（isComposing：中文選字時按 Enter 不送出）
  nameInput.elt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      submitName();
    }
  });
}

function showNameInput() {
  const r = cnv.elt.getBoundingClientRect();
  nameInput.value("");
  nameInput.show();
  // 置中放在畫布中間偏下（寬度 180 + padding 12 + border 4 = 196）
  nameInput.position(
    r.left + window.scrollX + width / 2 - 98,
    r.top + window.scrollY + (ROWS * CELL) / 2 + 5
  );
  nameInput.elt.focus();
}

function submitName() {
  if (state !== "enterName") return; // 避免重複送出
  const name = nameInput.value().trim().slice(0, 12) || "無名氏";
  nameInput.hide();
  state = "saving";
  addToLeaderboard(name, score).then(() => {
    sfxSubmit();
    state = "over";
  });
}

// ===== 音效（用 p5.sound 即時合成，不需要音檔） =====

function setupSound() {
  const osc = new p5.Oscillator("square");
  osc.amp(0);
  osc.start();
  const env = new p5.Envelope();
  env.setADSR(0.005, 0.08, 0.0, 0.05);
  env.setRange(0.25, 0);
  sfx = { osc, env };
}

// 播一個音：freq 頻率、delay 延遲秒數、wave 波形
function tone(freq, delay = 0, wave = "square") {
  if (muted) return;
  setTimeout(() => {
    sfx.osc.setType(wave);
    sfx.osc.freq(freq);
    sfx.env.play(sfx.osc);
  }, delay * 1000);
}

function sfxEat() {
  tone(660);
  tone(990, 0.05);
}

function sfxLevelUp() {
  tone(523, 0);    // C
  tone(659, 0.07); // E
  tone(784, 0.14); // G
  tone(1047, 0.21);// C
}

function sfxGameOver() {
  tone(392, 0, "sawtooth");
  tone(330, 0.15, "sawtooth");
  tone(262, 0.3, "sawtooth");
  tone(196, 0.45, "sawtooth");
}

function sfxStart() {
  tone(440);
  tone(880, 0.08);
}

function sfxSubmit() {
  tone(784);
  tone(1047, 0.08);
  tone(1319, 0.16);
}

function sfxClick() {
  tone(300, 0, "triangle");
}

// ===== 繪圖 =====

function drawGrid() {
  stroke(255, 255, 255, 12);
  strokeWeight(1);
  for (let x = 0; x <= COLS; x++) line(x * CELL, 0, x * CELL, ROWS * CELL);
  for (let y = 0; y <= ROWS; y++) line(0, y * CELL, COLS * CELL, y * CELL);
}

function drawSnake() {
  noStroke();
  for (let i = snake.length - 1; i >= 0; i--) {
    const s = snake[i];
    // 從頭到尾漸層：亮綠 → 深綠
    const t = snake.length > 1 ? i / (snake.length - 1) : 0;
    fill(lerpColor(color(120, 230, 120), color(30, 120, 60), t));
    rect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2, 5);
  }

  // 眼睛
  const h = snake[0];
  const cx = h.x * CELL + CELL / 2;
  const cy = h.y * CELL + CELL / 2;
  const px = -dir.y, py = dir.x; // 垂直於前進方向
  fill(20);
  circle(cx + dir.x * 4 + px * 4, cy + dir.y * 4 + py * 4, 4);
  circle(cx + dir.x * 4 - px * 4, cy + dir.y * 4 - py * 4, 4);
}

function drawFood() {
  noStroke();
  const pulse = 2 * sin(millis() * 0.008);
  fill(240, 80, 80);
  circle(food.x * CELL + CELL / 2, food.y * CELL + CELL / 2, CELL * 0.7 + pulse);
}

function drawHUD() {
  noStroke();
  fill(36, 38, 46);
  rect(0, ROWS * CELL, width, 40);
  fill(230);
  textSize(16);
  textAlign(LEFT, CENTER);
  text(`分數 ${score}`, 12, ROWS * CELL + 20);
  textAlign(CENTER, CENTER);
  fill(140);
  textSize(12);
  text(muted ? "M：開聲音" : "M：靜音", width / 2, ROWS * CELL + 20);
  fill(230);
  textSize(16);
  textAlign(RIGHT, CENTER);
  text(`最高 ${highScore()}`, width - 12, ROWS * CELL + 20);
}

function dimBoard() {
  noStroke();
  fill(0, 0, 0, 170);
  rect(0, 0, width, ROWS * CELL);
}

function drawMessage(title, sub) {
  dimBoard();
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(36);
  text(title, width / 2, ROWS * CELL / 2 - 20);
  textSize(14);
  fill(200);
  text(sub, width / 2, ROWS * CELL / 2 + 22);
}

function drawNameEntry() {
  dimBoard();
  textAlign(CENTER, CENTER);
  fill(255, 220, 90);
  textSize(28);
  text("新紀錄！", width / 2, ROWS * CELL / 2 - 70);
  fill(255);
  textSize(18);
  text(`分數 ${score}`, width / 2, ROWS * CELL / 2 - 35);
  fill(170);
  textSize(13);
  text("輸入名字後按 Enter", width / 2, ROWS * CELL / 2 + 70);
}

function drawLeaderboard() {
  dimBoard();
  textAlign(CENTER, CENTER);
  fill(255);
  textSize(26);
  text("遊戲結束", width / 2, 34);
  fill(200);
  textSize(14);
  text(`這局分數 ${score}`, width / 2, 62);

  // 標題列
  const top = 96;
  const rowH = 24;
  const left = 70;
  const right = width - 70;
  fill(120, 230, 120);
  textSize(15);
  text(db ? "— 雲端排行榜 —" : "— 本機排行榜 —", width / 2, top - 6);

  if (boardError) {
    fill(240, 110, 110);
    textSize(12);
    text(boardError, width / 2, ROWS * CELL - 40);
  }

  textSize(15);
  if (leaderboard.length === 0) {
    fill(150);
    textAlign(CENTER, CENTER);
    text("還沒有紀錄", width / 2, top + rowH * 2);
  }
  for (let i = 0; i < leaderboard.length; i++) {
    const e = leaderboard[i];
    const y = top + 20 + i * rowH;

    // 這局剛登上的名次：閃爍高亮
    if (i === lastRank) {
      noStroke();
      fill(120, 230, 120, 60 + 40 * sin(millis() * 0.008));
      rect(left - 10, y - rowH / 2, right - left + 20, rowH, 4);
    }

    // 前三名金銀銅
    const medal = [color(255, 210, 80), color(210, 210, 220), color(220, 150, 90)];
    fill(i < 3 ? medal[i] : color(220));
    textAlign(LEFT, CENTER);
    text(`${i + 1}.`, left, y);
    text(e.name, left + 34, y);
    textAlign(RIGHT, CENTER);
    text(e.score, right, y);
  }

  fill(170);
  textSize(13);
  textAlign(CENTER, CENTER);
  text("按 空白鍵 重新開始", width / 2, ROWS * CELL - 18);
}

// ===== 操作 =====

function keyPressed() {
  // 第一次按鍵時啟動瀏覽器的音訊（瀏覽器規定要使用者操作後才能出聲）
  userStartAudio();

  // 輸入名字、讀取或儲存中時，不處理遊戲按鍵
  if (state === "enterName" || state === "checking" || state === "saving") return;

  if (key === "m" || key === "M") {
    muted = !muted;
    if (!muted) sfxClick();
    return false;
  }

  // 空白鍵：開始 / 暫停 / 重新開始
  if (key === " ") {
    if (state === "start") {
      state = "play";
      sfxStart();
    } else if (state === "play") {
      state = "pause";
      sfxClick();
    } else if (state === "pause") {
      state = "play";
      sfxClick();
    } else if (state === "over") {
      resetGame();
      state = "play";
      sfxStart();
    }
    return false;
  }

  let d = null;
  if (keyCode === UP_ARROW || key === "w" || key === "W") d = createVector(0, -1);
  if (keyCode === DOWN_ARROW || key === "s" || key === "S") d = createVector(0, 1);
  if (keyCode === LEFT_ARROW || key === "a" || key === "A") d = createVector(-1, 0);
  if (keyCode === RIGHT_ARROW || key === "d" || key === "D") d = createVector(1, 0);

  if (d) {
    if (state === "start") {
      state = "play";
      sfxStart();
    }
    if (state === "play" && !(d.x === -dir.x && d.y === -dir.y)) {
      nextDir = d; // 不能直接反方向（會咬到自己）
    }
    return false; // 防止方向鍵捲動網頁
  }
}
