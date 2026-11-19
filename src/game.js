const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const ui = {
  stars: document.getElementById('star'),
  mode: document.getElementById('mode'),
  speed: document.getElementById('speed'),
  time: document.getElementById('time'),
  hint: document.getElementById('hint'),
  notice: document.getElementById('notice'),
  pause: document.getElementById('pause'),
};

const WORLD_SIZE = 2000;
const BLOCK_SIZE = 240;
const STEP = 1 / 120;
const TAU = Math.PI * 2;
const buildings = [];
const cars = [];
const pedestrians = [];
const keys = new Set();
const touchKeys = new Map();
const touchDevice = window.matchMedia('(pointer: coarse)');
const player = { x: 960, y: 960, r: 10, inCar: null, facing: 0 };
const view = { width: 0, height: 0, dpr: 1, x: 0, y: 0 };
let wanted = 0;
let calmTime = 0;
let day = 0;
let elapsedTime = 0;
let paused = false;
let lastTime = null;
let accumulator = 0;
let noticeUntil = 0;
let needsRender = true;

for (let x = 0; x + 210 <= WORLD_SIZE; x += BLOCK_SIZE) {
  for (let y = 0; y + 210 <= WORLD_SIZE; y += BLOCK_SIZE) {
    buildings.push({ x: x + 30, y: y + 30, w: 180, h: 180 });
  }
}

function circleHitsRect(x, y, radius, rect) {
  const closestX = Math.max(rect.x, Math.min(x, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(y, rect.y + rect.h));
  return (x - closestX) ** 2 + (y - closestY) ** 2 < radius ** 2;
}

function circleHitsCar(x, y, radius, car) {
  const dx = x - car.x;
  const dy = y - car.y;
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  return circleHitsRect(dx * cos + dy * sin, -dx * sin + dy * cos, radius, {
    x: -car.w / 2, y: -car.h / 2, w: car.w, h: car.h,
  });
}

function canOccupy(x, y, radius, ignoredCar = null) {
  if (x < radius || y < radius || x > WORLD_SIZE - radius || y > WORLD_SIZE - radius) {
    return false;
  }
  return !buildings.some(building => circleHitsRect(x, y, radius, building))
    && !cars.some(car => car !== ignoredCar && circleHitsCar(x, y, radius, car));
}

function spawnOnRoad(radius) {
  // Road centres always lie between building blocks. Try a bounded number of positions.
  for (let attempt = 0; attempt < 200; attempt++) {
    const horizontal = Math.random() < 0.5;
    const road = (1 + Math.floor(Math.random() * 8)) * BLOCK_SIZE;
    const along = 30 + Math.random() * (WORLD_SIZE - 60);
    const x = horizontal ? along : road;
    const y = horizontal ? road : along;
    const awayFromPlayer = Math.hypot(x - player.x, y - player.y) > radius + 30;
    const awayFromPedestrians = pedestrians.every(ped => Math.hypot(x - ped.x, y - ped.y) > radius + ped.r + 8);
    if (canOccupy(x, y, radius + 4) && awayFromPlayer && awayFromPedestrians) {
      return { x, y, angle: horizontal ? 0 : Math.PI / 2 };
    }
  }
  throw new Error('无法在道路上找到空闲的出生位置');
}

for (let index = 0; index < 10; index++) {
  const position = index === 0 ? { x: 1000, y: 960, angle: 0 } : spawnOnRoad(18);
  cars.push({
    ...position,
    w: 30,
    h: 16,
    r: 17,
    speed: 0,
    lastCrash: -Infinity,
    color: ['#df786c', '#72b7a6', '#739cce', '#dfbc70', '#ac8ccc'][index % 5],
  });
}

for (let index = 0; index < 15; index++) {
  pedestrians.push({
    ...spawnOnRoad(6),
    r: 6,
    hit: false,
    turnIn: Math.random() * 3,
    vx: 0,
    vy: 0,
  });
}

function notify(message) {
  ui.notice.textContent = message;
  noticeUntil = elapsedTime + 3;
}

function nearestCar() {
  let closest = null;
  let distance = 46;
  for (const car of cars) {
    const candidateDistance = Math.hypot(car.x - player.x, car.y - player.y);
    if (candidateDistance < distance) {
      closest = car;
      distance = candidateDistance;
    }
  }
  return closest;
}

function toggleCar() {
  if (paused) return;
  const car = player.inCar;
  if (!car) {
    player.inCar = nearestCar();
    if (!player.inCar) notify('靠近车辆后按 E 上车');
    return;
  }
  if (Math.abs(car.speed) > 30) {
    notify('请先减速停车，再下车');
    return;
  }
  // Check both sides and both ends so exiting cannot place the player inside a wall.
  for (const direction of [Math.PI / 2, -Math.PI / 2, Math.PI, 0]) {
    const distance = (Math.abs(Math.sin(direction)) > 0.5 ? car.h : car.w) / 2 + player.r + 8;
    const x = car.x + Math.cos(car.angle + direction) * distance;
    const y = car.y + Math.sin(car.angle + direction) * distance;
    if (canOccupy(x, y, player.r, car)) {
      player.x = x;
      player.y = y;
      player.inCar = null;
      car.speed = 0;
      return;
    }
  }
  notify('周围空间不足，请将车辆移到开阔处');
}

function clearInput() {
  keys.clear();
  touchKeys.clear();
  document.querySelectorAll('.pressed').forEach(button => button.classList.remove('pressed'));
}

function setPaused(value) {
  paused = value;
  clearInput();
  lastTime = null;
  accumulator = 0;
  needsRender = true;
  ui.pause.textContent = paused ? '继续' : '暂停';
  ui.pause.setAttribute('aria-pressed', String(paused));
}

const controlCodes = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'KeyE', 'KeyP']);
window.addEventListener('keydown', event => {
  if (!controlCodes.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (event.repeat || keys.has(event.code)) return;
  keys.add(event.code);
  if (event.code === 'KeyE') toggleCar();
  if (event.code === 'KeyP') setPaused(!paused);
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => setPaused(true));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) setPaused(true);
});
ui.pause.addEventListener('click', () => setPaused(!paused));

for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('pointerdown', event => {
    event.preventDefault();
    if (paused) return;
    button.setPointerCapture(event.pointerId);
    touchKeys.set(event.pointerId, button.dataset.key);
    button.classList.add('pressed');
    if (button.dataset.key === 'KeyE') toggleCar();
  });
  const release = event => {
    touchKeys.delete(event.pointerId);
    button.classList.remove('pressed');
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

function pressed(code, arrow) {
  return keys.has(code) || keys.has(arrow) || [...touchKeys.values()].includes(code);
}

function addWanted() {
  wanted = Math.min(5, wanted + 1);
  calmTime = 0;
}

function moveWalking(dt) {
  let dx = Number(pressed('KeyD', 'ArrowRight')) - Number(pressed('KeyA', 'ArrowLeft'));
  let dy = Number(pressed('KeyS', 'ArrowDown')) - Number(pressed('KeyW', 'ArrowUp'));
  const length = Math.hypot(dx, dy);
  if (!length) return;
  dx = dx / length * 180 * dt;
  dy = dy / length * 180 * dt;
  player.facing = Math.atan2(dy, dx);
  if (canOccupy(player.x + dx, player.y, player.r)) player.x += dx;
  if (canOccupy(player.x, player.y + dy, player.r)) player.y += dy;
}

function moveCar(dt) {
  const car = player.inCar;
  const throttle = Number(pressed('KeyW', 'ArrowUp')) - Number(pressed('KeyS', 'ArrowDown'));
  if (throttle) {
    car.speed = Math.max(-180, Math.min(360, car.speed + throttle * 720 * dt));
  } else {
    car.speed *= Math.exp(-3.1 * dt);
    if (Math.abs(car.speed) < 1) car.speed = 0;
  }
  const steering = Number(pressed('KeyD', 'ArrowRight')) - Number(pressed('KeyA', 'ArrowLeft'));
  car.angle += steering * 3.6 * Math.min(1, Math.abs(car.speed) / 90) * Math.sign(car.speed) * dt;
  car.angle %= TAU;
  const nextX = car.x + Math.cos(car.angle) * car.speed * dt;
  const nextY = car.y + Math.sin(car.angle) * car.speed * dt;
  if (canOccupy(nextX, nextY, car.r, car)) {
    car.x = nextX;
    car.y = nextY;
  } else {
    const impactSpeed = Math.abs(car.speed);
    car.speed *= -0.3;
    if (impactSpeed >= 120 && elapsedTime - car.lastCrash > 1) {
      car.lastCrash = elapsedTime;
      addWanted();
      notify('发生碰撞，通缉等级上升');
    }
  }
  for (const ped of pedestrians) {
    if (!ped.hit && Math.abs(car.speed) > 30 && circleHitsCar(ped.x, ped.y, ped.r, car)) {
      ped.hit = true;
      addWanted();
    }
  }
  player.x = car.x;
  player.y = car.y;
}

function movePedestrians(dt) {
  for (const ped of pedestrians) {
    if (ped.hit) continue;
    ped.turnIn -= dt;
    if (ped.turnIn <= 0) {
      const direction = Math.random() * TAU;
      ped.vx = Math.cos(direction) * 28;
      ped.vy = Math.sin(direction) * 28;
      ped.turnIn = 2 + Math.random() * 4;
    }
    if (canOccupy(ped.x + ped.vx * dt, ped.y, ped.r)) ped.x += ped.vx * dt;
    else ped.vx *= -1;
    if (canOccupy(ped.x, ped.y + ped.vy * dt, ped.r)) ped.y += ped.vy * dt;
    else ped.vy *= -1;
  }
}

function update(dt) {
  elapsedTime += dt;
  day = (day + dt / 180) % 1;
  if (player.inCar) moveCar(dt);
  else moveWalking(dt);
  movePedestrians(dt);
  if (wanted > 0) {
    calmTime += dt;
    if (calmTime >= 12) {
      wanted--;
      calmTime = 0;
    }
  }
  if (noticeUntil && elapsedTime >= noticeUntil) {
    ui.notice.textContent = '';
    noticeUntil = 0;
  }
}

function resize() {
  view.width = window.innerWidth;
  view.height = window.innerHeight;
  // Cap the backing buffer on high-density phones to keep memory use bounded.
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(view.width * view.dpr);
  canvas.height = Math.round(view.height * view.dpr);
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  needsRender = true;
}
window.addEventListener('resize', resize);
resize();

function cameraOffset(position, size) {
  if (size >= WORLD_SIZE) return (WORLD_SIZE - size) / 2;
  return Math.max(0, Math.min(position - size / 2, WORLD_SIZE - size));
}

function drawCity(night) {
  ctx.fillStyle = '#243b37';
  ctx.fillRect(0, 0, WORLD_SIZE, WORLD_SIZE);
  ctx.fillStyle = '#303b45';
  for (let road = 0; road <= WORLD_SIZE; road += BLOCK_SIZE) {
    ctx.fillRect(road - 30, 0, 60, WORLD_SIZE);
    ctx.fillRect(0, road - 30, WORLD_SIZE, 60);
  }
  ctx.strokeStyle = '#79816d';
  ctx.lineWidth = 1;
  ctx.setLineDash([12, 14]);
  ctx.beginPath();
  for (let road = 0; road <= WORLD_SIZE; road += BLOCK_SIZE) {
    ctx.moveTo(road, 0);
    ctx.lineTo(road, WORLD_SIZE);
    ctx.moveTo(0, road);
    ctx.lineTo(WORLD_SIZE, road);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  for (const building of buildings) {
    if (building.x + building.w < view.x || building.y + building.h < view.y
      || building.x > view.x + view.width || building.y > view.y + view.height) continue;
    const { x, y, w, h } = building;
    ctx.fillStyle = '#798b8940';
    ctx.fillRect(x - 5, y - 5, w + 10, h + 10);
    ctx.fillStyle = '#101d2580';
    ctx.fillRect(x + 7, y + 9, w, h);
    ctx.fillStyle = '#506170';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#5d7080';
    ctx.fillRect(x + 7, y + 7, w - 14, h - 14);
    ctx.fillStyle = '#465763';
    ctx.fillRect(x + 65, y + 65, 50, 50);
    ctx.fillStyle = night > 0.45 ? '#e7c981' : '#8aa0ac';
    for (let offset = 20; offset < w - 10; offset += 28) {
      ctx.fillRect(x + offset, y + 7, 12, 4);
      ctx.fillRect(x + offset, y + h - 11, 12, 4);
    }
  }
}

function drawCar(car) {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);
  ctx.fillStyle = '#10171d';
  ctx.fillRect(-11, -10, 7, 20);
  ctx.fillRect(6, -10, 7, 20);
  ctx.fillStyle = car.color;
  ctx.fillRect(-car.w / 2, -car.h / 2, car.w, car.h);
  ctx.fillStyle = '#223644';
  ctx.fillRect(3, -6, 5, 12);
  ctx.fillRect(-9, -6, 4, 12);
  ctx.fillStyle = '#f8e9b4';
  ctx.fillRect(13, -7, 2, 4);
  ctx.fillRect(13, 3, 2, 4);
  ctx.fillStyle = '#e56262';
  ctx.fillRect(-15, -7, 2, 4);
  ctx.fillRect(-15, 3, 2, 4);
  if (player.inCar === car) {
    ctx.strokeStyle = '#91efda';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-18, -12, 36, 24);
  }
  ctx.restore();
}

function render() {
  view.x = cameraOffset(player.x, view.width);
  view.y = cameraOffset(player.y, view.height);
  const night = (1 - Math.cos(day * TAU)) / 2;
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.fillStyle = '#142723';
  ctx.fillRect(0, 0, view.width, view.height);
  ctx.save();
  ctx.translate(-view.x, -view.y);
  drawCity(night);
  for (const ped of pedestrians) {
    if (ped.hit) continue;
    ctx.fillStyle = '#ead399';
    ctx.beginPath();
    ctx.arc(ped.x, ped.y, ped.r, 0, TAU);
    ctx.fill();
  }
  for (const car of cars) drawCar(car);
  if (!player.inCar) {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.facing);
    ctx.fillStyle = '#7ce8d2';
    ctx.beginPath();
    ctx.arc(0, 0, player.r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#163c38';
    ctx.fillRect(4, -4, 5, 8);
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = `rgba(7, 15, 36, ${night * 0.46})`;
  ctx.fillRect(0, 0, view.width, view.height);
  if (paused) {
    ctx.fillStyle = '#0b141bc7';
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.fillStyle = '#e2eee9';
    ctx.font = '24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('已暂停', view.width / 2, view.height / 2);
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('点击继续或按 P 返回游戏', view.width / 2, view.height / 2 + 32);
  }
  ui.stars.textContent = '★'.repeat(wanted) + '☆'.repeat(5 - wanted);
  ui.stars.setAttribute('aria-label', `${wanted} 级通缉`);
  ui.mode.textContent = player.inCar ? '驾驶' : '步行';
  ui.speed.textContent = player.inCar ? (Math.abs(player.inCar.speed) / 60).toFixed(1) : '0';
  ui.time.textContent = night < 0.5 ? '白天' : '夜晚';
  if (paused) ui.hint.textContent = '游戏已暂停';
  else if (player.inCar) {
    ui.hint.textContent = touchDevice.matches
      ? '↑ 加速 · ↓ 刹车 / 倒车 · ← → 转向 · 停车后点「上下车」'
      : 'W 加速 · S 刹车 / 倒车 · A D 转向 · 停车后按 E 下车';
  } else if (touchDevice.matches) {
    ui.hint.textContent = nearestCar() ? '点「上下车」进入车辆' : '靠近车辆后点「上下车」';
  } else {
    ui.hint.textContent = nearestCar() ? '按 E 上车' : '靠近车辆后按 E 上车';
  }
}

function loop(timestamp) {
  if (lastTime === null) lastTime = timestamp;
  const frameTime = Math.min((timestamp - lastTime) / 1000, 0.1);
  lastTime = timestamp;
  if (!paused) {
    accumulator += frameTime;
    while (accumulator >= STEP) {
      update(STEP);
      accumulator -= STEP;
    }
  }
  if (!paused || needsRender) {
    render();
    needsRender = false;
  }
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
