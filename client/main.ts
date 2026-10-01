import type { Board } from '../shared/board.ts';
import type {
  KnockoutState,
  LeaderboardEntry,
  LobbyView,
  MatchResult,
  MatchSnapshot,
  PlayerInfo,
  RacerStatus,
  RejectReason,
  ServerMessage,
} from '../shared/protocol.ts';
import {
  DEFAULT_OPTIONS,
  DURATIONS,
  durationLabel,
  GAME_MODES,
  MEMORY_REVEAL_MS,
  modeLabel,
  optionsKey,
  parseOptions,
  playerRange,
  pointsFor,
  QUEUE_MODES,
  SIZE_MODES,
  sizeModeLabel,
  SKIP_LOCKOUT_MS,
  SPIN_EVERY_MS,
  TWISTS,
  twistLabel,
  type GameMode,
  type QueueOptions,
  type Twist,
} from '../shared/rules.ts';
import { confetti, countUp, prefersReducedMotion } from './fx.ts';
import { Net, type NetStatus } from './net.ts';
import { PlayState } from './play-state.ts';
import {
  boardPoint,
  cellFromPoint,
  drawBoard,
  FLASH_MS,
  fxActive,
  gridIconSvg,
  PALETTE,
  PULSE_MS,
  spinAngle,
  stickyCell,
  type BoardFx,
  type Pointer,
} from './render.ts';
import { Sound } from './sound.ts';

// ---------- helpers ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode etc. Not fatal; we just won't remember.
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Writes text only when it changed, so per-frame HUD updates don't thrash layout. */
function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** A keyboard-shortcut hint chip (CSS shows these only for mouse + keyboard setups). */
function kbd(text: string): HTMLElement {
  return el('kbd', '', text);
}

/** Re-triggers a CSS animation class. */
function replay(node: HTMLElement, className: string): void {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

function optionsText(o: QueueOptions): string {
  const parts = [
    o.mode === 'race' ? '' : modeLabel(o.mode),
    sizeModeLabel(o.sizeMode),
    o.mode === 'knockout' ? `${durationLabel(o.durationSec)}/round` : durationLabel(o.durationSec),
    o.twists.map(twistLabel).join(' + '),
  ];
  return parts.filter(Boolean).join(' · ');
}

const MODE_HINTS: Record<GameMode, string> = {
  race: 'Solve the most boards before time runs out',
  tug: '1v1: each solve pulls the rope. Three boards ahead wins',
  knockout: 'One board per round. Last to solve it is out',
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

let toastTimer = 0;
function toast(text: string): void {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

/** Practice is always a plain race; bests are kept per board size and time. */
function bestKey(o: QueueOptions): string {
  return `flowrace.pb.${optionsKey({ ...o, mode: 'race' })}`;
}

/** Practice personal bests, per board option, remembered in this browser. */
function bestFor(o: QueueOptions): number | null {
  // Fall back to the key format used before game modes existed.
  const v = load(bestKey(o)) ?? load(`flowrace.pb.${o.sizeMode}:${o.durationSec}`);
  return v === null || Number.isNaN(Number(v)) ? null : Number(v);
}

// ---------- state ----------

type Screen = 'home' | 'lobby' | 'match' | 'result';

interface ClientMatch {
  id: string;
  options: QueueOptions;
  mode: GameMode;
  twists: Set<Twist>;
  /** Tug of war: points lead that wins. */
  tugTarget: number | null;
  knockout: KnockoutState | null;
  ranked: boolean;
  practice: boolean;
  lobbyCode: string | null;
  startsAt: number;
  endsAt: number;
  racers: PlayerInfo[];
  status: Map<string, RacerStatus>;
  boards: Map<number, Board>;
  /** Board the player is on (may run one ahead of the server after a solve). */
  index: number;
  /** Score the server has confirmed. */
  serverScore: number;
  /** Points for solves sent but not yet confirmed, by board index. Shown immediately. */
  pending: Map<number, number>;
  lockedUntil: number;
  play: PlayState | null;
  playIndex: number;
  /** Between a solve and showing the next board. */
  solving: boolean;
  lastFilledSent: number;
  lastProgressAt: number;
  /** Practice personal best when the run started. */
  best: number | null;
  // Effects (performance.now() times).
  appearAt: number;
  flashUntil: number;
  pulses: { color: number; at: number }[];
  gain: { text: string; at: number } | null;
  /** Last countdown / final-seconds second that made a sound. */
  beeped: number;
  wentGo: boolean;
}

function scoreOf(m: ClientMatch): number {
  let score = m.serverScore;
  for (const pts of m.pending.values()) score += pts;
  return score;
}

function loadOptions(): QueueOptions {
  try {
    const parsed = parseOptions(JSON.parse(load('flowrace.options') ?? 'null'));
    if (parsed) return parsed;
  } catch {
    // Fall through to defaults.
  }
  return { ...DEFAULT_OPTIONS };
}

function loadName(): string {
  let name = load('flowrace.name');
  if (!name) {
    name = `Player${Math.floor(100 + Math.random() * 900)}`;
    save('flowrace.name', name);
  }
  return name;
}

const app = {
  me: null as (PlayerInfo & { games: number }) | null,
  net: 'connecting' as NetStatus,
  selected: loadOptions(),
  counts: {} as Record<string, number>,
  queued: null as { options: QueueOptions; since: number } | null,
  lobby: null as LobbyView | null,
  match: null as ClientMatch | null,
  result: null as MatchResult | null,
  /** Practice outcome for the result screen. */
  practiceRecord: null as { matchId: string; previous: number | null; isNew: boolean } | null,
  leaderboard: null as { entries: LeaderboardEntry[]; you: { rank: number | null; rating: number; games: number } } | null,
  screen: 'home' as Screen,
};

const sound = new Sound(load('flowrace.muted') === '1');

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const net = new Net(
  wsUrl,
  () => ({ name: loadName(), token: load('flowrace.token') ?? undefined }),
  (token) => save('flowrace.token', token),
);

function requestLeaderboard(): void {
  if (app.net === 'online') net.send({ type: 'leaderboard.get' });
}

// ---------- screens ----------

function show(screen: Screen): void {
  app.screen = screen;
  document.body.dataset.screen = screen;
  document.body.classList.toggle('in-match', screen === 'match');
  void holdScreenAwake(screen === 'match');
  for (const s of ['home', 'lobby', 'match', 'result'] as const) $(`screen-${s}`).hidden = s !== screen;
  if (screen === 'home') {
    renderHome();
    requestLeaderboard();
  }
  if (screen === 'lobby') renderLobby();
  if (screen === 'match') {
    renderOpponents();
    invalidate();
  }
  if (screen === 'result') renderResult();
}

/** Where to go when nothing more specific is happening. */
function showIdle(): void {
  show(app.lobby ? 'lobby' : 'home');
}

function renderMe(): void {
  const me = app.me;
  $('me').innerHTML = '';
  const rank = app.leaderboard?.you.rank;
  setText($('stat-rating'), me ? String(me.rating) : '—');
  setText($('stat-rank'), rank ? `#${rank}` : '—');
  setText($('stat-games'), String(me?.games ?? 0));
  if (!me) return;
  $('me').append(el('b', '', me.name), el('br'), document.createTextNode(`Rating ${me.rating}${rank ? ` · #${rank}` : ''}`));
}

function renderConn(): void {
  const c = $('conn');
  c.dataset.status = app.net;
  c.querySelector('span')!.textContent =
    app.net === 'online' ? 'Online' : app.net === 'connecting' ? 'Connecting…' : app.net === 'replaced' ? 'Inactive' : 'Reconnecting…';
  renderHome();
}

const SPEAKER_ON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
const SPEAKER_OFF =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>';

function renderMute(): void {
  const b = $('mute-btn');
  b.innerHTML = sound.muted ? SPEAKER_OFF : SPEAKER_ON;
  b.setAttribute('aria-pressed', String(sound.muted));
  b.setAttribute('aria-label', sound.muted ? 'Unmute sounds' : 'Mute sounds');
}

function toggleMute(): void {
  sound.muted = !sound.muted;
  save('flowrace.muted', sound.muted ? '1' : '0');
  renderMute();
  if (!sound.muted) {
    sound.unlock();
    sound.connect(0);
  }
}

/** Mode, board-size, duration and (lobby-only) twist pickers, shared by the home screen and the lobby. */
function renderPicker(
  els: { modes: HTMLElement; sizes: HTMLElement; durations: HTMLElement; twists?: HTMLElement },
  options: QueueOptions,
  onChange: (o: QueueOptions) => void,
  { counts, disabled, modes }: { counts?: Record<string, number>; disabled?: boolean; modes: readonly GameMode[] },
): void {
  const { modes: modesEl, sizes: sizesEl, durations: durationsEl, twists: twistsEl } = els;
  modesEl.innerHTML = '';
  for (const mode of modes) {
    const b = el('button', '', modeLabel(mode));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(options.mode === mode));
    b.disabled = !!disabled;
    b.onclick = () => onChange({ ...options, mode });
    modesEl.append(b);
  }

  if (twistsEl) {
    twistsEl.innerHTML = '';
    for (const twist of TWISTS) {
      const on = options.twists.includes(twist);
      const b = el('button', 'twist', twistLabel(twist));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !!disabled;
      b.onclick = () =>
        onChange({ ...options, twists: on ? options.twists.filter((t) => t !== twist) : [...options.twists, twist] });
      twistsEl.append(b);
    }
  }

  sizesEl.innerHTML = '';
  for (const mode of SIZE_MODES) {
    const b = el('button', 'option');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(options.sizeMode === mode));
    b.disabled = !!disabled;
    b.innerHTML = gridIconSvg(mode);
    b.append(el('span', 'opt-main', mode === 'ramp' ? 'Ramp' : `${mode}×${mode}`));
    const waiting = counts?.[optionsKey({ ...options, sizeMode: mode })] ?? 0;
    const sub = el('span', 'opt-sub');
    if (waiting > 0) {
      sub.textContent = `${waiting} waiting`;
      sub.classList.add('live');
    } else {
      sub.textContent = mode === 'ramp' ? '5×5 → 9×9' : `${pointsFor(mode)} pt${pointsFor(mode) > 1 ? 's' : ''} each`;
    }
    b.append(sub);
    b.onclick = () => onChange({ ...options, sizeMode: mode });
    sizesEl.append(b);
  }

  durationsEl.innerHTML = '';
  for (const sec of DURATIONS) {
    const b = el('button', '', durationLabel(sec));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(options.durationSec === sec));
    b.disabled = !!disabled;
    b.onclick = () => onChange({ ...options, durationSec: sec });
    durationsEl.append(b);
  }
}

function renderHome(): void {
  if (app.screen !== 'home') return;
  const online = app.net === 'online';
  // The home screen queues, and knockout needs a lobby.
  if (!QUEUE_MODES.includes(app.selected.mode)) app.selected = { ...app.selected, mode: 'race' };
  renderPicker(
    { modes: $('home-modes'), sizes: $('home-sizes'), durations: $('home-durations') },
    app.selected,
    (o) => {
      app.selected = o;
      save('flowrace.options', JSON.stringify(o));
      renderHome();
    },
    { counts: app.counts, disabled: !!app.queued, modes: QUEUE_MODES },
  );
  $('home-mode-hint').textContent = MODE_HINTS[app.selected.mode];
  $('queue-btn').firstChild!.textContent = app.selected.mode === 'tug' ? 'Find tug of war ' : 'Find ranked match ';
  $('play-buttons').hidden = !!app.queued;
  ($('queue-btn') as HTMLButtonElement).disabled = !online;
  ($('practice-btn') as HTMLButtonElement).disabled = !online;
  const best = bestFor(app.selected);
  $('practice-best').textContent = best === null ? '' : `Your best: ${plural(best, 'pt')}`;
  $('queue-status').hidden = !app.queued;
  if (app.queued) $('queue-label').textContent = `Searching ${optionsText(app.queued.options)}`;
  ($('create-lobby') as HTMLButtonElement).disabled = !online || !!app.queued;
  ($('name-input') as HTMLInputElement).disabled = !!app.queued;
  renderLeaderboard();
}

function renderLeaderboard(): void {
  const list = $('leaderboard');
  list.innerHTML = '';
  const lb = app.leaderboard;
  if (!lb) {
    $('lb-you').textContent = '';
    return;
  }
  if (lb.entries.length === 0) {
    list.append(el('li', 'empty', 'No ranked games yet. Win one to claim #1.'));
  }
  for (const e of lb.entries.slice(0, 10)) {
    const li = el('li', e.id === app.me?.id ? 'me' : '');
    const who = el('span', 'who', e.name);
    who.append(el('small', '', plural(e.games, 'game')));
    li.append(el('span', 'rank', String(e.rank)), who, el('span', 'rating', String(e.rating)));
    list.append(li);
  }
  $('lb-you').textContent = lb.you.rank ? `You: #${lb.you.rank} · ${lb.you.rating}` : `You: ${lb.you.rating} · play ranked to place`;
}

function renderLobby(): void {
  const lobby = app.lobby;
  if (app.screen !== 'lobby' || !lobby || !app.me) return;
  const isHost = lobby.hostId === app.me.id;
  $('lobby-code').textContent = lobby.code;

  const list = $('lobby-members');
  list.innerHTML = '';
  lobby.members.forEach((m, i) => {
    const li = el('li');
    const dot = el('span', 'dot');
    dot.style.background = PALETTE[i % PALETTE.length];
    li.append(dot, el('span', 'who', m.name));
    if (m.id === lobby.hostId) li.append(el('span', 'tag', 'host'));
    if (m.id === app.me!.id) li.append(el('span', 'tag', 'you'));
    li.append(el('span', `state${m.ready ? ' ready' : ''}`, !m.connected ? 'offline' : m.ready ? 'Ready' : 'Not ready'));
    list.append(li);
  });

  $('lobby-options-label').textContent = isHost ? 'Mode' : 'Mode (host picks)';
  renderPicker(
    { modes: $('lobby-modes'), sizes: $('lobby-sizes'), durations: $('lobby-durations'), twists: $('lobby-twists') },
    lobby.options,
    (o) => net.send({ type: 'lobby.options', options: o }),
    { disabled: !isHost || !!lobby.matchId, modes: GAME_MODES },
  );
  $('lobby-mode-hint').textContent = MODE_HINTS[lobby.options.mode];
  $('lobby-time-label').textContent = lobby.options.mode === 'knockout' ? 'Time per round' : 'Time';

  const meReady = lobby.members.find((m) => m.id === app.me!.id)?.ready ?? false;
  const ready = $('ready-btn') as HTMLButtonElement;
  ready.replaceChildren(meReady ? 'Ready ✓' : 'Ready', kbd('R'));
  ready.classList.toggle('is-ready', meReady);
  ready.disabled = !!lobby.matchId;

  const waitingOn = lobby.members.filter((m) => !m.ready).length;
  const [min, max] = playerRange(lobby.options.mode);
  $('lobby-hint').textContent = lobby.matchId
    ? 'Race in progress…'
    : lobby.members.length < min
      ? 'Waiting for friends to join. Share the code or link.'
      : lobby.members.length > max
        ? `${modeLabel(lobby.options.mode)} is 1v1: it needs exactly ${max} players.`
        : waitingOn === 0
          ? 'Starting…'
          : `Race starts when everyone is ready (${waitingOn} to go).`;
}

// Opponent rows are built once per match and updated in place, so fill bars
// animate smoothly and "just scored" flashes aren't cut off by re-renders.
interface OppRow {
  row: HTMLElement;
  extra: HTMLElement;
  score: HTMLElement;
  fill: HTMLElement | null;
}
const oppRows = new Map<string, OppRow>();
let oppRowsFor = '';
let rope: { box: HTMLElement; knot: HTMLElement; text: HTMLElement } | null = null;

function buildRope(m: ClientMatch): HTMLElement {
  const opponent = m.racers.find((r) => r.id !== app.me?.id);
  const box = el('div', 'rope');
  const names = el('div', 'rope-names');
  names.append(el('span', '', opponent?.name ?? 'Them'), el('span', 'you', 'You'));
  const track = el('div', 'rope-track');
  const knot = el('i', 'rope-knot');
  track.append(el('i', 'goal them'), el('i', 'mid'), el('i', 'goal you'), knot);
  const text = el('div', 'rope-text');
  box.append(names, track, text);
  rope = { box, knot, text };
  return box;
}

function renderRope(m: ClientMatch, mine: number): void {
  if (!rope || m.tugTarget === null) return;
  const opponent = m.racers.find((r) => r.id !== app.me?.id);
  const theirs = opponent ? (m.status.get(opponent.id)?.score ?? 0) : 0;
  const lead = mine - theirs;
  const pull = Math.max(-1, Math.min(1, lead / m.tugTarget));
  rope.knot.style.left = `${50 + pull * 50}%`;
  rope.box.classList.toggle('winning', lead > 0);
  rope.box.classList.toggle('losing', lead < 0);
  setText(
    rope.text,
    lead > 0
      ? `You lead by ${plural(lead, 'pt')} · ${Math.max(0, m.tugTarget - lead)} to win`
      : lead < 0
        ? `${opponent?.name ?? 'They'} lead${opponent ? 's' : ''} by ${plural(-lead, 'pt')}`
        : `Even · first to ${plural(m.tugTarget, 'pt')} ahead wins`,
  );
}

function renderOpponents(): void {
  const m = app.match;
  const box = $('opponents');
  if (!m || !app.me) {
    box.innerHTML = '';
    oppRows.clear();
    oppRowsFor = '';
    return;
  }
  if (oppRowsFor !== m.id) {
    box.innerHTML = '';
    oppRows.clear();
    oppRowsFor = m.id;
    rope = null;
    if (m.tugTarget !== null) box.append(buildRope(m));
    if (m.practice) {
      const row = el('div', 'opp pb');
      const name = el('div', 'opp-name', 'Personal best');
      const extra = el('small', '', optionsText(m.options));
      name.append(extra);
      const score = el('div', 'opp-score');
      row.append(name, score);
      box.append(row);
      oppRows.set('pb', { row, extra, score, fill: null });
    }
    for (const r of m.racers) {
      if (r.id === app.me.id) continue;
      const row = el('div', 'opp');
      const name = el('div', 'opp-name', r.name);
      const extra = el('small');
      name.append(extra);
      const score = el('div', 'opp-score');
      const bar = el('div', 'opp-bar');
      const fill = el('i');
      bar.append(fill);
      row.append(name, score, bar);
      box.append(row);
      oppRows.set(r.id, { row, extra, score, fill });
    }
  }

  const mine = scoreOf(m);
  const pb = oppRows.get('pb');
  if (pb) {
    setText(pb.score, m.best === null ? '—' : String(m.best));
    pb.row.classList.toggle('beaten', mine > (m.best ?? 0));
  }
  renderRope(m, mine);
  const ko = m.knockout;
  for (const r of m.racers) {
    const ui = oppRows.get(r.id);
    if (!ui) continue;
    const st = m.status.get(r.id);
    ui.row.classList.toggle('offline', !!st && !st.connected);
    let state: string;
    if (ko) {
      // Knockout rows show who's still in, who's cleared this round, and who's out.
      const out = ko.eliminated.find((e) => e.id === r.id);
      const done = !out && !!st && st.boardIndex > ko.round;
      ui.row.classList.toggle('out', !!out);
      ui.row.classList.toggle('done', done);
      ui.row.classList.remove('ahead');
      state = out ? `out in round ${out.round + 1}` : done ? '✓ cleared' : 'solving';
    } else {
      ui.row.classList.toggle('ahead', !!st && st.score > mine);
      state = st ? `board ${st.boardIndex + 1}` : '';
    }
    const extra = [m.ranked ? `${r.rating}` : '', state, st && !st.connected ? 'offline' : ''].filter(Boolean).join(' · ');
    setText(ui.extra, extra);
    setText(ui.score, String(st?.score ?? 0));
    if (ui.fill) ui.fill.style.width = st ? `${Math.round((st.filled / st.boardSize ** 2) * 100)}%` : '0%';
  }
}

function flashOpponent(id: string): void {
  const ui = oppRows.get(id);
  if (ui) replay(ui.row, 'scored');
}

/** Which result we've already animated, so re-renders don't replay the effects. */
let animatedResult = '';

function renderResult(): void {
  const result = app.result;
  if (!result || !app.me) return;
  const meId = app.me.id;
  const mine = result.standings.find((s) => s.id === meId);
  const fresh = animatedResult !== result.matchId;
  animatedResult = result.matchId;

  const title = $('result-title');
  title.className = 'result-title';
  const sub = $('result-sub');
  sub.innerHTML = '';
  sub.append(document.createTextNode(`${optionsText(result.options)} · `));

  if (result.practice) {
    const record = app.practiceRecord?.matchId === result.matchId ? app.practiceRecord : null;
    title.textContent = record?.isNew ? 'New best!' : 'Practice done';
    if (record?.isNew) title.classList.add('win');
    const score = mine?.score ?? 0;
    sub.append(
      document.createTextNode(
        record?.isNew && record.previous !== null
          ? `${plural(score, 'pt')}, up from ${record.previous}`
          : record?.previous !== null && record?.previous !== undefined
            ? `${plural(score, 'pt')} · best ${record.previous}`
            : plural(score, 'pt'),
      ),
    );
  } else {
    if (result.winnerId === meId) {
      title.textContent = 'Victory!';
      title.classList.add('win');
    } else if (result.winnerId === null && mine?.place === 1) {
      title.textContent = 'Draw';
    } else if (result.standings.length === 2) {
      title.textContent = 'Defeat';
      title.classList.add('loss');
    } else {
      title.textContent = `${ordinal(mine?.place ?? result.standings.length)} place`;
    }
    const change = result.ratings?.[meId];
    if (change) {
      const delta = change.after - change.before;
      sub.append(document.createTextNode(`Rating ${change.before} → ${change.after} `));
      const deltaEl = el('span', delta >= 0 ? 'delta-up' : 'delta-down');
      const fmt = (n: number) => `(${n >= 0 ? '+' : ''}${n})`;
      sub.append(deltaEl);
      if (fresh) countUp(deltaEl, delta, fmt);
      else deltaEl.textContent = fmt(delta);
    } else {
      sub.append(document.createTextNode('Unranked'));
    }
  }

  const list = $('standings');
  list.innerHTML = '';
  result.standings.forEach((s, i) => {
    const li = el('li', s.id === meId ? 'me' : '');
    li.style.setProperty('--i', String(i));
    const who = el('div', 'who', s.id === meId ? `${s.name} (you)` : s.name);
    who.append(
      el(
        'small',
        '',
        result.options.mode === 'knockout'
          ? `cleared ${plural(s.solved, 'round')}`
          : `${s.solved} solved · ${s.skipped} skipped`,
      ),
    );
    li.append(el('div', 'place', String(s.place)), who, el('div', 'pts', String(s.score)));
    list.append(li);
  });

  const actions = $('result-actions');
  actions.innerHTML = '';
  const home = el('button', 'ghost', 'Home');
  home.onclick = () => showIdle();
  if (result.lobbyCode && app.lobby?.code === result.lobbyCode) {
    const back = el('button', 'primary big', 'Back to lobby');
    back.append(kbd('Enter'));
    back.onclick = () => show('lobby');
    actions.append(back);
  } else if (result.practice) {
    const again = el('button', 'primary big', `Practice again (${optionsText(result.options)})`);
    again.append(kbd('Enter'));
    again.onclick = () => net.send({ type: 'practice.start', options: result.options });
    actions.append(again, home);
  } else {
    const again = el('button', 'primary big', `Race again (${optionsText(result.options)})`);
    again.append(kbd('Enter'));
    again.onclick = () => {
      app.selected = result.options;
      save('flowrace.options', JSON.stringify(result.options));
      net.send({ type: 'queue.join', options: result.options });
      show('home');
    };
    actions.append(again, home);
  }
}

// ---------- match ----------

function applySnapshot(s: MatchSnapshot): void {
  const prev = app.match?.id === s.matchId ? app.match : null;
  // A new knockout round restarts the countdown, so its beeps and "GO" play again.
  const sameStart = prev?.startsAt === s.startsAt;
  const m: ClientMatch = {
    id: s.matchId,
    options: s.options,
    mode: s.options.mode,
    twists: new Set(s.options.twists),
    tugTarget: s.tugTarget,
    knockout: s.knockout,
    ranked: s.ranked,
    practice: s.practice,
    lobbyCode: s.lobbyCode,
    startsAt: s.startsAt,
    endsAt: s.endsAt,
    racers: s.racers,
    status: new Map(s.status.map((r) => [r.id, r])),
    boards: prev?.boards ?? new Map(),
    index: s.you.boardIndex,
    serverScore: s.you.score,
    pending: new Map(),
    lockedUntil: s.you.lockedUntil,
    play: null,
    playIndex: -1,
    solving: false,
    lastFilledSent: -1,
    lastProgressAt: 0,
    best: prev ? prev.best : s.practice ? bestFor(s.options) : null,
    appearAt: prev?.appearAt ?? 0,
    flashUntil: 0,
    pulses: [],
    gain: null,
    beeped: sameStart ? prev!.beeped : -1,
    wentGo: sameStart ? prev!.wentGo : false,
  };
  for (const { index, board } of s.boards) m.boards.set(index, board);
  // Keep what the player has drawn if they're still on the same board.
  if (prev?.play && prev.playIndex === m.index && prev.play.board.id === m.boards.get(m.index)?.id) {
    m.play = prev.play;
    m.playIndex = prev.playIndex;
  }
  app.match = m;
  app.queued = null;
  app.result = null;
  $('end-btn').hidden = !m.practice;
  // No skipping in knockout: you clear the board or you're out.
  $('skip-btn').hidden = m.mode === 'knockout';
  setText($('hud-board-label'), m.mode === 'knockout' ? 'Round' : 'Board');
  ensurePlay(m);
  renderOpponents();
}

/** Knockout: you're still in and haven't cleared this round's board yet. */
function stillSolving(m: ClientMatch): boolean {
  const ko = m.knockout;
  return !ko || (ko.alive.includes(app.me?.id ?? '') && m.index === ko.round);
}

function ensurePlay(m: ClientMatch): void {
  if (m.play && m.playIndex === m.index) return;
  const board = m.boards.get(m.index);
  m.play = board ? new PlayState(board) : null;
  m.playIndex = board ? m.index : -1;
  m.lastFilledSent = -1;
  m.appearAt = performance.now();
  m.pulses = [];
  // A new board mid-drag (e.g. after a resync) ends the stroke.
  drawing = null;
  pointer = null;
  hoverCell = null;
  invalidate();
}

function canPlay(m: ClientMatch): boolean {
  const now = net.now();
  return !!m.play && !m.solving && now >= m.startsAt && now < m.endsAt && now >= m.lockedUntil && stillSolving(m);
}

function completedFlags(play: PlayState): boolean[] {
  return play.paths.map((_, c) => play.isComplete(c));
}

/** After any change to the drawing: effects, sounds, solve detection, and an immediate repaint. */
function afterDraw(m: ClientMatch, before: boolean[]): void {
  const play = m.play;
  if (!play) return;
  const now = performance.now();
  let connected = 0;
  play.paths.forEach((_, c) => {
    if (play.isComplete(c) && !before[c]) {
      m.pulses.push({ color: c, at: now });
      connected++;
    }
  });
  if (play.isSolved()) solve(m);
  else if (connected > 0) sound.connect(play.completedCount());
  paint();
}

function solve(m: ClientMatch): void {
  const play = m.play!;
  const index = m.index;
  // Knockout scores rounds cleared, not board points.
  const pts = m.mode === 'knockout' ? 1 : pointsFor(play.size);
  net.send({ type: 'match.submit', boardIndex: index, paths: play.solution() });
  // Count it straight away; the server's ack confirms (or a reject resyncs).
  m.pending.set(index, pts);
  play.end();
  drawing = null;
  pointer = null;
  m.solving = true;
  const now = performance.now();
  m.flashUntil = now + FLASH_MS;
  m.gain = { text: m.mode === 'knockout' ? 'Safe!' : `+${pts}`, at: now };
  sound.solve();
  renderOpponents();
  // Let the flash land, then move on without waiting for the server.
  setTimeout(() => {
    m.solving = false;
    if (app.match === m && m.index === index) {
      m.index = index + 1;
      ensurePlay(m);
    }
  }, FLASH_MS);
}

function skipBoard(): void {
  const m = app.match;
  if (!m || !canPlay(m)) return;
  net.send({ type: 'match.skip', boardIndex: m.index });
  sound.skip();
  m.lockedUntil = net.now() + SKIP_LOCKOUT_MS;
  m.index++;
  ensurePlay(m);
}

function undoStroke(): void {
  const m = app.match;
  if (!m?.play || !canPlay(m) || drawing) return;
  if (m.play.undo()) paint();
}

function clearBoard(): void {
  const m = app.match;
  if (!m?.play || !canPlay(m) || drawing) return;
  m.play.clear();
  paint();
}

const REJECT_TEXT: Record<RejectReason, string> = {
  'not-live': 'The race has not started yet.',
  'time-up': 'Too late, time is up!',
  'wrong-board': 'Out of sync, reloading your board.',
  locked: 'Still locked out after skipping.',
  invalid: 'That solution was not accepted.',
  'too-fast': 'Solved suspiciously fast, so it did not count.',
};

// ---------- board drawing & input ----------

const canvas = $('board') as HTMLCanvasElement;

/**
 * The one pointer currently drawing. A second finger, a resting palm, or a
 * touch while the pen is down is ignored rather than hijacking the pipe.
 */
let drawing: { id: number; type: string; cell: number } | null = null;
/** Finger position for the touch bubble, in board units (touch only; a pen or mouse doesn't hide the board). */
let pointer: Pointer | null = null;
/**
 * Fog twist: where the player last pointed, in screen coordinates. Kept in
 * screen space so the clear patch stays under the cursor while Spin turns the board.
 */
let fogClient: { x: number; y: number } | null = null;
/** Cell under a mouse/pen that isn't drawing, for the grab highlight. */
let hoverCell: number | null = null;
/** Set when the board needs repainting; idle boards aren't redrawn (saves battery). */
let dirty = true;

function invalidate(): void {
  dirty = true;
}

/** Spin twist: the board's rotation right now, on the shared server clock. */
function boardAngle(m: ClientMatch): number {
  return m.twists.has('spin') ? spinAngle(Math.max(0, net.now() - m.startsAt), SPIN_EVERY_MS) : 0;
}

/** Screen position to board units, through the Spin and Mirror twists. */
function toBoard(m: ClientMatch, play: PlayState, clientX: number, clientY: number): Pointer {
  return boardPoint(canvas.getBoundingClientRect(), play.size, clientX, clientY, {
    angle: boardAngle(m),
    mirror: m.twists.has('mirror'),
  });
}

function fxOf(m: ClientMatch): BoardFx {
  const now = performance.now();
  if (m.pulses.length > 0) m.pulses = m.pulses.filter((p) => now < p.at + PULSE_MS);
  // Memory twist: the 3-second look starts when the board is actually visible,
  // not while it's still behind a countdown or skip lockout.
  const toPerf = (serverTime: number) => now + (serverTime - net.now());
  const visibleFrom = Math.max(m.appearAt, toPerf(m.startsAt), toPerf(m.lockedUntil));
  return {
    now,
    appearAt: m.appearAt,
    flashUntil: m.flashUntil,
    pulses: m.pulses,
    gain: m.gain,
    reducedMotion: prefersReducedMotion(),
    hover: hoverCell,
    angle: boardAngle(m),
    fog: m.twists.has('fog') ? (fogClient && m.play ? toBoard(m, m.play, fogClient.x, fogClient.y) : 'hidden') : null,
    colourless: m.twists.has('memory') && now > visibleFrom + MEMORY_REVEAL_MS,
  };
}

/** Draws right now. Called straight from input handlers for the lowest possible latency. */
function paint(): void {
  const m = app.match;
  if (app.screen !== 'match' || !m?.play) return;
  drawBoard(canvas, m.play, pointer, fxOf(m));
  dirty = false;
}

new ResizeObserver(invalidate).observe(canvas);

function trackPointer(e: PointerEvent): void {
  const m = app.match;
  if (!m?.play) return;
  fogClient = { x: e.clientX, y: e.clientY };
  if (drawing?.type !== 'touch') return;
  // Draw the bubble where the finger is about to be, not where it was a frame ago.
  const p = e.getPredictedEvents?.().at(-1) ?? e;
  pointer = toBoard(m, m.play, p.clientX, p.clientY);
}

canvas.addEventListener('pointerdown', (e) => {
  if (drawing || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const m = app.match;
  if (!m?.play || !canPlay(m)) return;
  const cell = cellFromPoint(m.play.size, toBoard(m, m.play, e.clientX, e.clientY));
  if (cell === null) return;
  const before = completedFlags(m.play);
  if (!m.play.begin(cell)) return;
  e.preventDefault();
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // Capture is a nicety (keeps the drag when leaving the canvas); drawing works without it.
  }
  drawing = { id: e.pointerId, type: e.pointerType, cell };
  hoverCell = null;
  if (e.pointerType !== 'touch') canvas.style.cursor = 'grabbing';
  trackPointer(e);
  afterDraw(m, before);
});

/** Mouse/pen hovering without drawing: highlight what a click would grab. */
function updateHover(e: PointerEvent): void {
  const m = app.match;
  const play = m?.play;
  fogClient = { x: e.clientX, y: e.clientY };
  const cell =
    e.pointerType === 'touch' || !m || !play || !canPlay(m)
      ? null
      : cellFromPoint(play.size, toBoard(m, play, e.clientX, e.clientY));
  if (cell === hoverCell) return;
  hoverCell = cell;
  const grabbable = cell !== null && !!play && (play.dotAt(cell) >= 0 || play.ownerAt(cell) >= 0);
  canvas.style.cursor = grabbable ? 'grab' : 'default';
  paint();
}

canvas.addEventListener('pointerleave', () => {
  if (drawing || hoverCell === null) return;
  hoverCell = null;
  paint();
});

canvas.addEventListener('pointermove', (e) => {
  const m = app.match;
  if (!drawing) return updateHover(e);
  if (e.pointerId !== drawing.id || !m?.play || m.play.active === null) return;
  trackPointer(e);
  if (!canPlay(m)) return;
  // Touch digitizers report many samples per frame; replay them all so a fast
  // swipe follows the exact route instead of cutting corners.
  const samples = e.getCoalescedEvents?.() ?? [];
  const before = completedFlags(m.play);
  let changed = false;
  for (const s of samples.length > 0 ? samples : [e]) {
    const cell = stickyCell(m.play.size, toBoard(m, m.play, s.clientX, s.clientY), drawing.cell);
    if (cell === drawing.cell) continue;
    drawing.cell = cell;
    if (m.play.drag(cell)) changed = true;
    if (m.play.isSolved()) break;
  }
  if (changed) afterDraw(m, before);
  else if (pointer) paint(); // The touch bubble moved.
});

function endDrag(e: PointerEvent): void {
  if (!drawing || e.pointerId !== drawing.id) return;
  app.match?.play?.end();
  drawing = null;
  pointer = null;
  canvas.style.cursor = '';
  invalidate();
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);

// Windows turns a touch press-and-hold into a right-click menu, which would
// interrupt a drag whenever you pause on a cell.
$('screen-match').addEventListener('contextmenu', (e) => e.preventDefault());

/** Keeps a tablet's screen from dimming mid-race. */
let wakeLock: { release(): Promise<void> } | null = null;
async function holdScreenAwake(on: boolean): Promise<void> {
  try {
    if (on && !wakeLock && document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  // The browser drops the lock when the tab is hidden; take it back on return.
  wakeLock = null;
  if (app.screen === 'match') void holdScreenAwake(true);
});

// ---------- per-frame HUD ----------

function renderVs(m: ClientMatch): void {
  const node = $('overlay-vs');
  const others = m.racers.filter((r) => r.id !== app.me?.id);
  const ko = m.knockout;
  const key = m.practice ? 'practice' : ko ? `ko:${m.id}:${ko.round}` : others.map((r) => r.id).join();
  if (node.dataset.key === key) return;
  node.dataset.key = key;
  node.innerHTML = '';
  if (ko) {
    const nameOf = (id: string) => (id === app.me?.id ? 'You' : (m.racers.find((r) => r.id === id)?.name ?? '?'));
    node.append(document.createTextNode(`Round ${ko.round + 1}`));
    if (ko.round > 0 && ko.lastOut.length > 0) {
      node.append(el('span', 'vs', '·'), document.createTextNode(`${ko.lastOut.map(nameOf).join(' & ')} out`));
    }
  } else if (m.practice) {
    node.textContent = m.best === null ? 'Practice' : `Practice · beat ${plural(m.best, 'pt')}`;
  } else if (others.length === 1) {
    const o = others[0];
    node.append(document.createTextNode('You'), el('span', 'vs', 'vs'), document.createTextNode(m.ranked ? `${o.name} (${o.rating})` : o.name));
  } else {
    node.textContent = `${others.length + 1}-player race`;
  }
}

function renderMatchFrame(m: ClientMatch): void {
  const now = net.now();
  const timer = $('hud-timer');
  const left = now < m.startsAt ? m.endsAt - m.startsAt : m.endsAt - now;
  setText(timer, clock(left));
  timer.classList.toggle('low', now >= m.startsAt && left > 0 && left < 10_000);

  // Countdown beeps, "GO", and ticks through the final ten seconds.
  if (now < m.startsAt) {
    const sec = Math.ceil((m.startsAt - now) / 1000);
    if (sec <= 3 && sec !== m.beeped) {
      m.beeped = sec;
      sound.countdown(false);
    }
  } else if (!m.wentGo) {
    m.wentGo = true;
    if (now < m.startsAt + 1000) sound.countdown(true);
  } else if (left > 0 && left <= 10_000) {
    const sec = Math.ceil(left / 1000);
    if (sec !== m.beeped) {
      m.beeped = sec;
      sound.tick();
    }
  }

  const score = $('hud-score');
  const shown = String(scoreOf(m));
  if (score.textContent !== shown) {
    score.textContent = shown;
    replay(score, 'score-pop');
  }
  const ko = m.knockout;
  setText($('hud-board'), String((ko ? ko.round : m.index) + 1));
  const myOut = ko?.eliminated.find((e) => e.id === app.me?.id);

  let big = '';
  let small = '';
  let mode: '' | 'solid' | 'go' = '';
  if (myOut) {
    big = 'Out';
    small = `Knocked out in round ${myOut.round + 1} · watching`;
    mode = 'solid';
  } else if (now < m.startsAt) {
    big = String(Math.ceil((m.startsAt - now) / 1000));
    small = `${optionsText(m.options)}${m.ranked ? ' · ranked' : ''}`;
    mode = 'solid';
    renderVs(m);
  } else if (now < m.startsAt + 700 && !prefersReducedMotion()) {
    big = 'GO!';
    mode = 'go';
  } else if (ko && m.index > ko.round) {
    const left = ko.alive.filter((id) => id !== app.me?.id && (m.status.get(id)?.boardIndex ?? 0) <= ko.round).length;
    big = '✓';
    small = left > 0 ? `Cleared · waiting on ${left} more` : 'Cleared!';
  } else if (now >= m.endsAt) {
    big = 'Time!';
    small = ko ? 'Round over' : 'Tallying results…';
  } else if (now < m.lockedUntil) {
    big = String(Math.ceil((m.lockedUntil - now) / 1000));
    small = 'Skipped. Next board unlocks in…';
    mode = 'solid';
  } else if (!m.play) {
    big = '…';
    small = 'Loading next board';
    mode = 'solid';
  }
  const overlay = $('overlay');
  overlay.hidden = !big;
  overlay.classList.toggle('solid', mode === 'solid');
  overlay.classList.toggle('go', mode === 'go');
  $('overlay-vs').hidden = !(now < m.startsAt) || !!myOut;
  const bigEl = $('overlay-big');
  if (bigEl.textContent !== big) {
    bigEl.textContent = big;
    if (mode === 'solid' && /^\d$/.test(big)) replay(bigEl, 'tick');
    else bigEl.classList.remove('tick');
  }
  setText($('overlay-small'), small);

  const play = m.play;
  if (play) {
    if (dirty || m.twists.size > 0 || fxActive(fxOf(m), play.board.dots.length)) paint();
    const filled = play.filledCount();
    setText($('board-flows'), `${play.completedCount()}/${play.paths.length} flows`);
    setText($('board-worth'), m.mode === 'knockout' ? 'Clear it to stay in' : `+${plural(pointsFor(play.size), 'pt')}`);
    setText($('board-fill'), `${Math.floor((filled / play.size ** 2) * 100)}% filled`);
    if (filled !== m.lastFilledSent && performance.now() - m.lastProgressAt > 250) {
      net.send({ type: 'match.progress', boardIndex: m.playIndex, filled });
      m.lastFilledSent = filled;
      m.lastProgressAt = performance.now();
    }
  }
  const playable = canPlay(m);
  ($('skip-btn') as HTMLButtonElement).disabled = !playable;
  ($('clear-btn') as HTMLButtonElement).disabled = !playable;
  ($('undo-btn') as HTMLButtonElement).disabled = !playable || !m.play?.canUndo;

  // Safety net: if the result never arrives (e.g. we were offline when it ended), move on.
  if (now > m.endsAt + 6000) {
    app.match = null;
    toast('The race ended while you were disconnected.');
    showIdle();
  }
}

function frame(): void {
  if (app.screen === 'match' && app.match) renderMatchFrame(app.match);
  if (app.screen === 'home' && app.queued) setText($('queue-timer'), clock(net.now() - app.queued.since + 999));
  requestAnimationFrame(frame);
}

// ---------- server messages ----------

function onResult(result: MatchResult): void {
  const meId = app.me?.id;
  const mine = result.standings.find((s) => s.id === meId);
  if (result.practice && mine) {
    const previous = bestFor(result.options);
    const isNew = mine.score > 0 && (previous === null || mine.score > previous);
    if (isNew) save(bestKey(result.options), String(mine.score));
    app.practiceRecord = { matchId: result.matchId, previous, isNew };
  }

  app.match = null;
  app.result = result;
  const change = meId ? result.ratings?.[meId] : undefined;
  if (app.me && change) {
    app.me.rating = change.after;
    app.me.games++;
    renderMe();
  }
  show('result');

  const won = result.winnerId === meId || (result.practice && app.practiceRecord?.isNew);
  const lost = !result.practice && result.winnerId !== null && result.winnerId !== meId;
  if (won) {
    sound.win();
    confetti();
  } else if (lost) {
    sound.lose();
  }
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome': {
      app.me = msg.player;
      app.queued = null;
      renderMe();
      renderHome();
      requestLeaderboard();
      const join = new URLSearchParams(location.search).get('join');
      if (join) {
        history.replaceState(null, '', location.pathname);
        net.send({ type: 'lobby.join', code: join });
      }
      return;
    }
    case 'queue.stats':
      app.counts = msg.counts;
      return renderHome();
    case 'queue.status':
      app.queued = msg.queued && msg.since !== null ? { options: msg.queued, since: msg.since } : null;
      return renderHome();
    case 'leaderboard':
      app.leaderboard = { entries: msg.entries, you: msg.you };
      renderMe();
      return renderLeaderboard();
    case 'lobby.state':
      app.lobby = msg.lobby;
      if (msg.lobby && app.screen === 'home') return show('lobby');
      if (!msg.lobby && app.screen === 'lobby') return show('home');
      // The results screen offers "Back to lobby" only while the lobby exists.
      if (app.screen === 'result') return renderResult();
      return renderLobby();
    case 'match.state':
      applySnapshot(msg);
      return show('match');
    case 'match.board': {
      const m = app.match;
      if (m?.id !== msg.matchId) return;
      m.boards.set(msg.index, msg.board);
      return ensurePlay(m);
    }
    case 'match.ack': {
      const m = app.match;
      if (m?.id !== msg.matchId) return;
      m.pending.delete(msg.boardIndex);
      m.serverScore = msg.score;
      m.lockedUntil = msg.lockedUntil;
      if (msg.boardIndex >= m.index) {
        m.index = msg.boardIndex + 1;
        ensurePlay(m);
      }
      return renderOpponents();
    }
    case 'match.reject':
      if (app.match?.id !== msg.matchId) return;
      app.match.pending.delete(msg.boardIndex);
      toast(REJECT_TEXT[msg.reason]);
      return;
    case 'match.racer': {
      const m = app.match;
      if (m?.id !== msg.matchId) return;
      const prev = m.status.get(msg.racer.id);
      m.status.set(msg.racer.id, msg.racer);
      renderOpponents();
      if (prev && msg.racer.score > prev.score) {
        flashOpponent(msg.racer.id);
        sound.rival();
      }
      return;
    }
    case 'match.result':
      return onResult(msg.result);
    case 'error':
      if (msg.code === 'version') {
        showBanner('A new version is available.', 'Reload', () => location.reload());
      } else if (msg.code !== 'replaced') {
        toast(msg.message);
      }
      return;
  }
}

function showBanner(text: string, action: string, onAction: () => void): void {
  const banner = $('banner');
  banner.innerHTML = '';
  const button = el('button', 'primary', action);
  button.onclick = () => {
    banner.hidden = true;
    onAction();
  };
  banner.append(el('div', '', text), button);
  banner.hidden = false;
}

// ---------- wiring ----------

net.onMessage = handle;
net.onStatus = (status) => {
  app.net = status;
  renderConn();
  if (status === 'replaced') {
    showBanner('Flow Race is open in another tab.', 'Play here instead', () => net.connect());
  }
};

// Browsers only allow sound after a user gesture.
document.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
/**
 * Keyboard shortcuts for mouse-and-keyboard players:
 * anywhere M mute; race Ctrl+Z undo, C clear, S skip; home F find match,
 * P practice, Esc cancel search; lobby R ready; results Enter continue.
 */
document.addEventListener('keydown', (e) => {
  sound.unlock();
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z') {
    if (app.screen === 'match') {
      e.preventDefault();
      undoStroke();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  // Let Enter/Space activate a focused button natively instead of doubling up.
  if ((key === 'enter' || key === ' ') && e.target instanceof HTMLButtonElement) return;

  const click = (id: string) => ($(id) as HTMLButtonElement).click();
  if (key === 'm') return toggleMute();
  switch (app.screen) {
    case 'match':
      if (key === 's') skipBoard();
      else if (key === 'c') clearBoard();
      return;
    case 'home':
      if (app.queued) {
        if (key === 'escape') click('cancel-queue');
      } else if (key === 'f') click('queue-btn');
      else if (key === 'p') click('practice-btn');
      return;
    case 'lobby':
      if (key === 'r') click('ready-btn');
      return;
    case 'result':
      if (key === 'enter') ($('result-actions').querySelector('.primary') as HTMLButtonElement | null)?.click();
      return;
  }
});

const nameInput = $('name-input') as HTMLInputElement;
nameInput.value = loadName();
nameInput.addEventListener('change', () => {
  const name = nameInput.value.trim().slice(0, 16);
  if (!name) {
    nameInput.value = loadName();
    return;
  }
  save('flowrace.name', name);
  // Names are sent on connect; reconnect to apply it (only offered while idle).
  if (!app.queued && !app.lobby && !app.match) net.reconnect();
});

$('mute-btn').onclick = toggleMute;
$('queue-btn').onclick = () => net.send({ type: 'queue.join', options: app.selected });
$('practice-btn').onclick = () => net.send({ type: 'practice.start', options: app.selected });
$('cancel-queue').onclick = () => net.send({ type: 'queue.leave' });
$('create-lobby').onclick = () => net.send({ type: 'lobby.create', options: app.selected });
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('join-code') as HTMLInputElement;
  if (input.value.trim()) net.send({ type: 'lobby.join', code: input.value });
  input.value = '';
});

$('leave-lobby').onclick = () => net.send({ type: 'lobby.leave' });
$('ready-btn').onclick = () => {
  const me = app.lobby?.members.find((m) => m.id === app.me?.id);
  net.send({ type: 'lobby.ready', ready: !me?.ready });
};
$('copy-code').onclick = async () => {
  if (!app.lobby) return;
  const link = `${location.origin}${location.pathname}?join=${app.lobby.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied');
  } catch {
    toast(`Share this link: ${link}`);
  }
};

$('skip-btn').onclick = skipBoard;
$('undo-btn').onclick = undoStroke;
$('clear-btn').onclick = clearBoard;
$('end-btn').onclick = () => net.send({ type: 'practice.stop' });

renderMute();
show('home');
renderConn();
net.connect();
requestAnimationFrame(frame);
