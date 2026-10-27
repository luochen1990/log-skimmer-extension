// sim.js — GitHub 日志查看器行为仿真 (fixture; 行为镜像 T3 DOM-REPORT):
//   ① 行渲染: div[data-index] 外壳 (0-based 逻辑行号) > .js-check-step-line.CheckStep-line
//      (.CheckStep-line-number 行号 + .CheckStep-line-timestamp + .js-check-line-content),
//      ANSI SGR → span.ansifg-N/.text-bold; ##[error]/::warning:: → log-line-{type}。
//   ② 虚拟化: 50 行/cluster; 滚动时仅保留视口 ±50 行窗口内 cluster, 窗口外清空占位。
//   ③ step 展开 = 清空重渲染 (parser.setData("") 语义); 收起/展开不保行 DOM。
// 观测面: window.__ghSim (attach/detach/render 计数, 供 e2e 断言)。

const CLUSTER = 50, PAD_LINES = 50, LINE_H = 21;
const textCache = new Map();
window.__ghSim = { attaches: 0, detaches: 0, renders: 0, clusters: 0 };

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** ANSI SGR → span (近似 GitHub 的 ansifg-N 形态) */
function ansiToHtml(s) {
  const parts = s.split(/(\x1b\[[0-9;]*m)/);
  let bold = false, fg = null, out = '', open = false;
  const flush = () => { if (open) { out += '</span>'; open = false; } };
  for (const p of parts) {
    const m = p.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      for (const code of m[1].split(';').map(Number)) {
        if (code === 0) { bold = false; fg = null; flush(); }
        else if (code === 1) { bold = true; flush(); }
        else if (code >= 30 && code <= 37) { fg = code - 30; flush(); }
        else if (code >= 90 && code <= 97) { fg = code - 90 + 8; flush(); }
      }
    } else if (p) {
      if (bold || fg !== null) {
        const cls = [fg !== null ? `ansifg-${fg}` : '', bold ? 'text-bold' : ''].filter(Boolean).join(' ');
        out += `<span class="${cls}">`; open = true;
      }
      out += esc(p);
      if (bold || fg !== null) { out += '</span>'; open = false; }
    }
  }
  flush();
  return out || '&nbsp;';
}

/** 行解析: 剥行首时间戳 (GitHub parser 同款 /^(.{27}Z) /) + 行类型判定 */
function parseLines(text) {
  return text.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).map((raw) => {
    const m = raw.match(/^(.{27}Z) ?/);
    const content = m ? raw.slice(m[0].length) : raw;
    let type = 'plain';
    if (content.startsWith('##[error]')) type = 'error';
    else if (content.startsWith('##[warning]') || content.startsWith('::warning')) type = 'warning';
    else if (content.startsWith('##[group]')) type = 'group';
    else if (content.startsWith('##[endgroup]')) type = 'endgroup';
    else if (content.startsWith('##[')) type = 'command';
    return { ts: m ? m[1] : '', content, type };
  });
}

class StepView {
  constructor(cs) {
    this.cs = cs;
    this.details = cs.querySelector('details.js-checks-log-details');
    this.container = cs.querySelector('.js-checks-log-display-container');
    this.stepNo = cs.getAttribute('data-number');
    // ##[group] 折叠建模 (opt-in: data-group-fold; 真实 GitHub 的 group 折叠头 class
    // 待登录态校准, fixture 契约 = details.lsk-group[data-gstart][data-gend])
    this.groupFold = cs.hasAttribute('data-group-fold');
    this.groups = [];      // [{s, e}] 0-based 闭区间 (含头/尾行)
    this.groupAt = new Map(); // 头行 idx → group
    this.clusters = [];
    this.details.addEventListener('toggle', () => { if (this.details.open) this.render(); });
  }

  async text() {
    const url = this.cs.getAttribute('data-log-url');
    if (!textCache.has(url)) textCache.set(url, await (await fetch(url)).text());
    return textCache.get(url);
  }

  /** 展开 = 清空重建 (T3: parser.setData("") + logsContainer.textContent="") */
  async render() {
    this.lines = parseLines(await this.text());
    if (this.groupFold) this.computeGroups();
    else { this.groups = []; this.groupAt.clear(); }
    this.container.textContent = '';
    this.clusters = [];
    for (let s = 0; s < this.lines.length; s += CLUSTER) {
      const end = Math.min(s + CLUSTER - 1, this.lines.length - 1);
      const w = document.createElement('div');
      w.className = 'lsk-cluster';
      w.dataset.start = s; w.dataset.end = end;
      // 占位高度先行 (T3: 窗口外 wrapper 测高占位; 未 attach 过的用行数估算),
      // 保证视口窗口判定对所有 cluster 都有非零矩形。
      w.style.height = `${(end - s + 1) * LINE_H}px`;
      this.container.appendChild(w);
      this.clusters.push({ w, start: s, end, attached: false, h: (end - s + 1) * LINE_H });
    }
    window.__ghSim.renders++;
    window.__ghSim.clusters = this.clusters.length;
    this.updateWindow();
  }

  /** ##[group]..##[endgroup] → 折叠区 (fixture 契约: group 不跨 cluster; 未闭合忽略) */
  computeGroups() {
    this.groups = []; this.groupAt.clear();
    let s = -1;
    this.lines.forEach((l, i) => {
      if (l.type === 'group') s = i;
      else if (l.type === 'endgroup' && s >= 0) {
        const g = { s, e: i };
        this.groups.push(g); this.groupAt.set(s, g); s = -1;
      }
    });
  }

  /** 视口 ±50 行窗口 (T3: t-50<=endIndex && t+50>=startIndex 等价实现) */
  updateWindow() {
    const vh = window.innerHeight;
    const pad = PAD_LINES * LINE_H;
    for (const cl of this.clusters) {
      const r = cl.w.getBoundingClientRect();
      const inWin = r.bottom > -pad && r.top < vh + pad;
      if (inWin && !cl.attached) this.attach(cl);
      else if (!inWin && cl.attached) this.detach(cl);
    }
    window.__ghSim.attachedNow = this.clusters.filter((c) => c.attached).length;
  }

  attach(cl) {
    cl.w.style.height = '';
    cl.w.textContent = '';
    const frag = document.createDocumentFragment();
    let i = cl.start;
    while (i <= cl.end) {
      const g = this.groupAt.get(i);
      if (g) {
        // group 折叠区: 头行为 summary (常显), 体行 data-index 保留在 DOM (收起即隐藏)
        const d = document.createElement('details');
        d.className = 'lsk-group';
        d.dataset.gstart = g.s; d.dataset.gend = g.e;
        const sum = document.createElement('summary');
        sum.appendChild(this.lineEl(g.s));
        d.appendChild(sum);
        for (let j = g.s + 1; j <= g.e; j++) d.appendChild(this.lineEl(j));
        frag.appendChild(d);
        i = g.e + 1;
      } else {
        frag.appendChild(this.lineEl(i));
        i++;
      }
    }
    cl.w.appendChild(frag);
    cl.attached = true;
    window.__ghSim.attaches++;
  }

  detach(cl) {
    if (cl.w.offsetHeight) cl.h = cl.w.offsetHeight;   // 实测优先 (换行行高)
    cl.w.style.height = cl.h + 'px';   // 测高占位 (T3: wrapper.style.height; textContent="")
    cl.w.textContent = '';
    cl.attached = false;
    window.__ghSim.detaches++;
  }

  lineEl(i) {
    const { ts, content, type } = this.lines[i];
    const shell = document.createElement('div');
    shell.dataset.index = i;
    const line = document.createElement('div');
    line.className = `js-check-step-line CheckStep-line d-flex log-line-${type}`;
    const no = document.createElement('a');
    no.className = 'CheckStep-line-number';
    no.href = `#step:${this.stepNo}:${i + 1}`;
    no.textContent = i + 1;
    const tsp = document.createElement('span');
    tsp.className = 'CheckStep-line-timestamp';
    tsp.textContent = ts;
    const c = document.createElement('span');
    c.className = 'js-check-line-content CheckStep-line-content d-inline-block flex-auto';
    c.innerHTML = ansiToHtml(content);
    line.append(no, tsp, c);
    shell.appendChild(line);
    return shell;
  }
}

const views = [...document.querySelectorAll('check-step')].map((cs) => new StepView(cs));
// 时间戳开关 (T3: 容器 class 切换, 纯 CSS)
document.querySelector('.js-checks-log-timestamps')?.addEventListener('change', (e) => {
  document.querySelector('.js-check-steps').classList.toggle('CheckRun-show-timestamps', e.target.checked);
});
// 滚动驱动窗口化 (rAF 节流)
let tick = false;
window.addEventListener('scroll', () => {
  if (tick) return;
  tick = true;
  requestAnimationFrame(() => { tick = false; views.forEach((v) => v.details.open && v.updateWindow()); });
});
// 初始: data-expand 的 step 自动展开 (T3: 失败 step SSR 自动展开; open 置位触发 toggle→render)
for (const v of views) {
  if (v.cs.hasAttribute('data-expand')) v.details.open = true;
}
