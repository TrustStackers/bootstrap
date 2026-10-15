/**
 * Bootstrap Dashboard — Two-pane blessed TUI.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │  Bootstrap Server  │  PeerID: 12D3...  │  DNS: bootstrap.example  │  ← Header
 *   ├────────────────────┬───────────────────────────────────────────────┤
 *   │  Peers (3/8)       │  Bootstrap Activity  (or)  Relay Usage         │
 *   │  ────────────────  │  ───────────────────────────────────────────  │
 *   │  ● 12D3...abc     │  [14:32:01] Peer 12D3...xyz connected         │
 *   │  ○ 12D3...def     │  [14:31:45] Relay: abc→def (256B)             │
 *   │  ◌ 12D3...ghi     │  [14:30:12] Relationship: abc↔def             │
 *   │                    │  ... (scrollable)                              │
 *   │  ● connected      │                                                  │
 *   │  ○ reachable      │                                                  │
 *   │  ◌ unreachable    │                                                  │
 *   ├────────────────────┴───────────────────────────────────────────────┤
 *   │  Local: 192.168.1.5:4001  Internet: bootstrap.example.com:4001    │  ← Footer
 *   │  [R] Relay  [B] Bootstrap  [l] Reload  [c] Clear Peers  [q] Quit  │  ← Command bar
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * This file only imports from the API layer — it never touches the database
 * or libp2p node directly.
 */

import blessed from 'blessed';
import type { BootstrapAPI, ActivityEntry, ServerInfo, RelayStats, RelayCircuit } from '../api/bootstrap-api.js';
import type { PeerRecord } from '../db/peer-db.js';

// ---------------------------------------------------------------------------
// Color helpers for activity types
// ---------------------------------------------------------------------------

function activityColor(type: string): string {
  switch (type) {
    case 'peer_connect': return 'green';
    case 'peer_disconnect': return 'red';
    case 'peer_register': return 'cyan';
    case 'relationship': return 'yellow';
    case 'relay': return 'magenta';
    case 'relay_monitor': return 'blue';
    case 'error': return 'red';
    default: return 'white';
  }
}

function activityTag(type: string): string {
  switch (type) {
    case 'peer_connect': return 'CONN';
    case 'peer_disconnect': return 'DISC';
    case 'peer_register': return 'REG ';
    case 'relationship': return 'REL ';
    case 'relay': return 'RLY ';
    case 'relay_monitor': return 'MON ';
    case 'error': return 'ERR ';
    default: return 'INFO';
  }
}

// ---------------------------------------------------------------------------
// Peer state display helpers
// ---------------------------------------------------------------------------

function peerStateIcon(state: string): string {
  switch (state) {
    case 'connected': return '\u25CF';
    case 'reachable': return '\u25CB';
    default: return '\u25CC';
  }
}

/**
 * Best human label for a peer: its configured user name, namespaced when known.
 * Falls back to the vta:<net>:<name> URI, then to the bare namespace, then to
 * nothing (PeerID only). Exported for unit testing.
 */
export function peerLabel(peer: PeerRecord): string {
  if (peer.agentName) return peer.net ? `${peer.agentName} (${peer.net})` : peer.agentName;
  if (peer.nameUri) return peer.nameUri;
  // A peer that has announced only its network/group (e.g. a utility server that
  // registered a namespace before a name was known) still deserves a label:
  // show the group rather than a bare peer ID.
  if (peer.net) return peer.net;
  return '';
}

function formatPeerLine(peer: PeerRecord): string {
  const icon = peerStateIcon(peer.state);
  // PeerID trimmed to a ~24-char column, with the peer's name beside it. The
  // full ID is still on the peer record if it's ever needed.
  const shortId = peer.peerId.length > 24
    ? peer.peerId.slice(0, 23) + '\u2026'
    : peer.peerId;
  const label = peerLabel(peer);
  const name = label
    ? '  ' + (label.length > 22 ? label.slice(0, 21) + '\u2026' : label)
    : '';
  const timeStr = formatTimestamp(peer.lastSeen);
  return `  ${icon} ${shortId.padEnd(24)}${name}  ${timeStr}`;
}

function formatTimestamp(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Content builders
// ---------------------------------------------------------------------------

function buildHeaderContent(info: ServerInfo): string {
  const shortId = info.peerId.length > 20
    ? info.peerId.slice(0, 16) + '\u2026'
    : info.peerId;

  let content = ' Bootstrap Server ';
  content += ` \u2502 PeerID: ${shortId}`;
  if (info.relayAddr) {
    content += ' \u2502 Relay: ON';
  }
  if (info.dnsHostname) {
    content += ` \u2502 ${info.dnsHostname}`;
  }
  return content;
}

function extractPort(addr: string): string {
  const tcpMatch = addr.match(/\/tcp\/(\d+)/);
  if (tcpMatch) return tcpMatch[1];
  const wsMatch = addr.match(/\/ws\/(\d+)/);
  if (wsMatch) return wsMatch[1];
  return '4001';
}

function buildFooterContent(info: ServerInfo, counts: { total: number; connected: number }): string {
  const localIp = info.localIp ?? '0.0.0.0';
  const tcpAddr = info.addrs.find(a => a.includes('/tcp/'));
  const tcpPort = tcpAddr ? extractPort(tcpAddr) : '4001';

  let line1 = '';
  if (info.localIp) {
    line1 = `  Local: ${localIp}:${tcpPort}`;
  }
  if (info.dnsHostname) {
    const wsAddr = info.addrs.find(a => a.includes('/ws/'));
    const wsPort = wsAddr ? extractPort(wsAddr) : '4002';
    if (line1) line1 += `   \u2502   `;
    line1 += `Internet: ${info.dnsHostname}:${tcpPort} / WS:${wsPort}`;
  }
  if (info.relayAddr) {
    if (line1) line1 += `   \u2502   `;
    line1 += `Relay: ${info.relayAddr}`;
  }

  const line2 = `  Peers: ${counts.connected} connected / ${counts.total} total`;
  return `${line1}\n${line2}`;
}

function buildRelayStatsHeader(stats: RelayStats): string {
  const time = formatTimestamp(Math.floor(stats.lastUpdated.getTime() / 1000));
  return `  \u25CF ${stats.relayConnCount} circuit(s) active  |  ${time}`;
}

function shortPeerId(peerId: string): string {
  return peerId.length > 16 ? peerId.slice(0, 16) : peerId;
}

function formatCircuitLine(circuit: RelayCircuit): string {
  const shortId = shortPeerId(circuit.peerId);
  const role = circuit.role === 'source' ? 'src' : 'dst';
  if (circuit.status === 'connected') {
    const time = formatTimestamp(Math.floor(circuit.connectedAt.getTime() / 1000));
    return `  \u25CF ${shortId}  ${role}  connected   ${time}`;
  }
  const time = circuit.disconnectedAt
    ? formatTimestamp(Math.floor(circuit.disconnectedAt.getTime() / 1000))
    : '--:--:--';
  return `  \u25CC ${shortId}  ${role}  disconnected ${time}`;
}

// ---------------------------------------------------------------------------
// showDashboard
// ---------------------------------------------------------------------------

export function showDashboard(
  screen: blessed.Widgets.Screen,
  api: BootstrapAPI,
): Promise<void> {
  const headerHeight = 1;
  const footerHeight = 2;
  const cmdBarHeight = 1;

  // ── Header ─────────────────────────────────────────────────────────────

  const header = blessed.text({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    height: headerHeight,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, bg: 'cyan', fg: 'black' },
    content: buildHeaderContent(api.getServerInfo()),
  });

  // ── Left Pane: Peer List ───────────────────────────────────────────────

  const leftWidth = '42%';
  const peerPane = blessed.box({
    parent: screen,
    top: headerHeight,
    left: 0,
    width: leftWidth,
    bottom: footerHeight + cmdBarHeight,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
  });

  const peerLabel = blessed.text({
    parent: peerPane,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    content: ' Peers ',
    tags: true,
    style: { fg: 'cyan', bold: true },
  });

  const peerList = blessed.list({
    parent: peerPane,
    top: 2,
    left: 0,
    right: 0,
    bottom: 3,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { bg: 'cyan', fg: 'black' },
      item: { fg: 'white' },
    },
  });

  blessed.text({
    parent: peerPane,
    bottom: 0,
    left: 1,
    right: 1,
    height: 3,
    content: '  \u25CF connected   \u25CB reachable   \u25CC unreachable\n  \u2191/\u2193 navigate  [Tab] activity log\n',
    tags: true,
    style: { fg: 'gray' },
  });

  // ── Right Pane: Bootstrap Activity Log (default visible) ───────────────

  const bootstrapLogPane = blessed.log({
    parent: screen,
    top: headerHeight,
    left: leftWidth,
    right: 0,
    bottom: footerHeight + cmdBarHeight,
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    label: ' Bootstrap Activity (\u2191/\u2193 PgUp/PgDn to scroll, [Tab] back to peers) ',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '\u2502', style: { fg: 'blue', inverse: true } },
    mouse: true,
    keys: true,
    vi: true,
    tags: true,
  });

  // ── Right Pane: Relay Usage (hidden by default) ────────────────────────

  const relayPane = blessed.box({
    parent: screen,
    top: headerHeight,
    left: leftWidth,
    right: 0,
    bottom: footerHeight + cmdBarHeight,
    border: { type: 'line' },
    style: { border: { fg: 'magenta' } },
    label: ' Relay Usage (\u2191/\u2193 PgUp/PgDn to scroll, [Tab] back to peers) ',
    hidden: true,
  });

  const relayStatsHeader = blessed.text({
    parent: relayPane,
    top: 0,
    left: 1,
    right: 1,
    height: 1,
    content: buildRelayStatsHeader(api.getRelayStats()),
    tags: true,
    style: { fg: 'magenta', bold: true },
  });

  const relayCircuitList = blessed.list({
    parent: relayPane,
    top: 2,
    left: 0,
    right: 0,
    bottom: 0,
    keys: true,
    vi: true,
    mouse: true,
    style: {
      selected: { bg: 'magenta', fg: 'black' },
      item: { fg: 'white' },
    },
  });

  // ── Footer (server/network info) ────────────────────────────────────────

  const footer = blessed.text({
    parent: screen,
    bottom: cmdBarHeight,
    left: 0,
    right: 0,
    height: footerHeight,
    border: { type: 'line' },
    style: { border: { fg: 'gray' }, fg: 'gray' },
    content: buildFooterContent(api.getServerInfo(), api.getPeerCount()),
  });

  // ── Bottom Command Bar ───────────────────────────────────────────────────

  blessed.text({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: cmdBarHeight,
    tags: true,
    style: { bg: 'blue', fg: 'white' },
    content: ' {bold}[R]{/bold} Relay   {bold}[B]{/bold} Bootstrap   {bold}[l]{/bold} Reload   {bold}[c]{/bold} Clear Peers   {bold}[q]{/bold} Quit ',
  });

  // ── State ──────────────────────────────────────────────────────────────

  let currentPeers: PeerRecord[] = [];
  /** Which right-hand pane is visible: 'bootstrap' (default) or 'relay'. */
  let currentPane: 'bootstrap' | 'relay' = 'bootstrap';

  function refreshPeerList() {
    currentPeers = api.getPeers();
    const items = currentPeers.length > 0
      ? currentPeers.map(formatPeerLine)
      : ['  (no peers yet)'];
    peerList.setItems(items);

    const counts = api.getPeerCount();
    peerLabel.setContent(` Peers (${counts.connected}/${counts.total}) `);
  }

  function refreshHeader() {
    header.setContent(buildHeaderContent(api.getServerInfo()));
  }

  function refreshFooter() {
    footer.setContent(buildFooterContent(api.getServerInfo(), api.getPeerCount()));
  }

  function refreshRelayStatsHeader() {
    relayStatsHeader.setContent(buildRelayStatsHeader(api.getRelayStats()));
  }

  function refreshRelayCircuits() {
    const circuits = api.getRelayCircuits();
    const items = circuits.length > 0
      ? circuits.map(formatCircuitLine)
      : ['  (no relay circuits yet)'];
    relayCircuitList.setItems(items);
  }

  function refreshAll() {
    refreshPeerList();
    refreshHeader();
    refreshFooter();
    refreshRelayStatsHeader();
    refreshRelayCircuits();
    screen.render();
  }

  // ── Pane switching ─────────────────────────────────────────────────────

  function showPane(pane: 'bootstrap' | 'relay') {
    currentPane = pane;
    if (pane === 'bootstrap') {
      bootstrapLogPane.show();
      relayPane.hide();
      bootstrapLogPane.focus();
    } else {
      bootstrapLogPane.hide();
      relayPane.show();
      refreshRelayStatsHeader();
      refreshRelayCircuits();
      relayCircuitList.focus();
    }
    screen.render();
  }

  // ── Log activity entry ─────────────────────────────────────────────────

  function logActivityEntry(entry: ActivityEntry, log: blessed.Widgets.Log) {
    const color = activityColor(entry.type);
    const tag = activityTag(entry.type);
    const time = formatTimestamp(Math.floor(entry.timestamp.getTime() / 1000));
    log.log(`{${color}-fg}[${time}] ${tag} ${entry.message}{/${color}-fg}`);
  }

  // ── Load existing activity and wire events ─────────────────────────────

  const existingEntries = api.getActivityLog();
  for (const entry of existingEntries) {
    // Relay monitor entries feed the fixed circuit list, not a scrolling log.
    if (entry.type === 'relay_monitor') {
      continue;
    }
    logActivityEntry(entry, bootstrapLogPane);
  }

  api.on('activity', (entry: ActivityEntry) => {
    if (entry.type === 'relay_monitor') {
      refreshRelayStatsHeader();
    } else {
      logActivityEntry(entry, bootstrapLogPane);
    }
    screen.render();
  });

  api.on('relay:circuits', () => {
    refreshRelayStatsHeader();
    refreshRelayCircuits();
    screen.render();
  });

  api.on('peer:connected', () => refreshAll());
  api.on('peer:disconnected', () => refreshAll());
  api.on('peer:registered', () => refreshAll());
  api.on('relationship:formed', () => refreshAll());
  api.on('peers:cleared', () => refreshAll());

  // ── Initial render ─────────────────────────────────────────────────────

  refreshAll();
  peerList.focus();
  screen.render();

  // ── Clear Peers confirmation dialog ─────────────────────────────────────

  function showClearPeersConfirm() {
    const dialog = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 7,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      label: ' Confirm ',
      tags: true,
      content:
        '\n  Clear all NON-CONNECTED peer & relationship records?\n' +
        '  Connected peers are kept and stay visible.\n\n' +
        '  {bold}[y]{/bold} Yes, clear    {bold}[n/Esc]{/bold} Cancel',
    });
    screen.render();

    const cleanup = () => {
      dialog.destroy();
      screen.render();
    };

    dialog.key(['y', 'Y'], () => {
      const result = api.clearPeers();
      cleanup();
      refreshAll();
      bootstrapLogPane.log(
        `{yellow-fg}[${formatTimestamp(Math.floor(Date.now() / 1000))}] INFO Cleared ${result.peersDeleted} peer(s), ${result.relationshipsDeleted} relationship(s)${result.peersKept > 0 ? `, kept ${result.peersKept} connected` : ''}{/yellow-fg}`,
      );
      screen.render();
    });
    dialog.key(['n', 'N', 'escape'], cleanup);
    dialog.focus();
  }

  // ── Focus toggle between peer list and activity log ─────────────────────

  let logFocused = false;

  // Store the original style so we can restore it when returning focus
  const defaultPeerSelectedStyle = { bg: 'cyan', fg: 'black' };
  const dimPeerSelectedStyle = { bg: 'gray', fg: 'white' };

  screen.key(['tab'], () => {
    if (logFocused) {
      // Return focus to peer list
      peerList.style.selected = defaultPeerSelectedStyle;
      peerList.focus();
      logFocused = false;
    } else {
      // Move focus to the currently visible activity pane
      peerList.style.selected = dimPeerSelectedStyle;
      if (currentPane === 'bootstrap') {
        bootstrapLogPane.focus();
      } else {
        relayCircuitList.focus();
      }
      logFocused = true;
    }
    screen.render();
  });

  // ── Key bindings ───────────────────────────────────────────────────────

  screen.key(['R', 'r'], () => {
    showPane('relay');
  });

  screen.key(['B', 'b'], () => {
    showPane('bootstrap');
  });

  screen.key(['l'], () => {
    refreshAll();
  });

  screen.key(['c'], () => {
    showClearPeersConfirm();
  });

  screen.key(['q', 'C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  // Keep the dashboard alive
  return new Promise<void>(() => { /* lives until [q] or Ctrl-C */ });
}