// =====================
// PEER MANAGER (WebRTC)
// =====================
class PeerManager {
    constructor() {
        this.peer = null;
        this.connections = new Map();
        this.isHost = false;
        this.roomId = null;
        this.myId = null;
        this.myName = null;
        this.onMessageCallback = null;
        this.onConnectionCallback = null;
        this.onDisconnectionCallback = null;
    }

    createRoom(playerName) {
        return new Promise((resolve, reject) => {
            this.isHost = true;
            this.myName = playerName;
            this.roomId = this.generateRoomId();
            this.peer = new Peer(this.roomId, { debug: 0 });

            this.peer.on('open', (id) => {
                this.myId = id;
                resolve(id);
            });
            this.peer.on('connection', (conn) => this.setupConnection(conn));
            this.peer.on('error', (err) => reject(err));
        });
    }

    joinRoom(roomId, playerName) {
        return new Promise((resolve, reject) => {
            this.isHost = false;
            this.myName = playerName;
            this.roomId = roomId;
            this.peer = new Peer({ debug: 0 });

            this.peer.on('open', (myId) => {
                this.myId = myId;
                const conn = this.peer.connect(roomId, { reliable: true, metadata: { name: playerName } });
                this.setupConnection(conn);
                conn.on('open', () => resolve());
                conn.on('error', (err) => reject(err));
            });
            this.peer.on('error', (err) => reject(err));
        });
    }

    setupConnection(conn) {
        conn.on('open', () => {
            this.connections.set(conn.peer, conn);
            if (this.onConnectionCallback) this.onConnectionCallback(conn.peer, conn.metadata?.name || 'Joueur');
        });
        conn.on('data', (data) => { if (this.onMessageCallback) this.onMessageCallback(data, conn.peer); });
        conn.on('close', () => {
            this.connections.delete(conn.peer);
            if (this.onDisconnectionCallback) this.onDisconnectionCallback(conn.peer);
        });
    }

    broadcast(data) { this.connections.forEach((conn) => { if (conn.open) conn.send(data); }); }
    
    sendToHost(data) {
        if (!this.isHost && this.roomId) {
            const hostConn = this.connections.get(this.roomId);
            if (hostConn && hostConn.open) hostConn.send(data);
        }
    }

    generateRoomId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let id = 'VQ-';
        for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
    }

    disconnect() { if (this.peer) { this.peer.destroy(); } }
}

// =====================
// GAME STATE
// =====================
const GameState = {
    players: [],
    currentPlayerIndex: 0,
    currentCharacter: null,
    currentAuthorId: null,
    currentTheme: null,
    themeProposals: {},
    votes: {},
    phase: 'lobby',
    isLastChance: false,
    isLegendRound: false
};

// =====================
// DOM ELEMENTS
// =====================
const $ = (id) => document.getElementById(id);
const screens = {
    welcome: $('welcomeScreen'), lobby: $('lobbyScreen'), theme: $('themeScreen'), themeReveal: $('themeRevealScreen'),
    input: $('inputScreen'), waiting: $('waitingScreen'), voting: $('votingScreen'), result: $('resultScreen'),
    gameover: $('gameOverScreen'), legendInput: $('legendInputScreen')
};

const peerManager = new PeerManager();

// =====================
// UTILITIES
// =====================
function showScreen(name) { Object.values(screens).forEach(s => s.classList.remove('active')); screens[name].classList.add('active'); }

function showToast(msg, type = 'success') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast ' + type;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}

function updateHeaderPlayers() {
    const active = GameState.players.filter(p => !p.eliminated);
    $('activePlayerCount').textContent = active.length;
    $('headerPlayers').innerHTML = GameState.players.map((p) => {
        let cls = 'player-tag';
        if (p.eliminated) cls += ' eliminated';
        if (GameState.players.indexOf(p) === GameState.currentPlayerIndex && !p.eliminated && GameState.phase !== 'lobby' && GameState.phase !== 'gameover') cls += ' active';
        return `<div class="${cls}">${p.name}<span class="score">${p.score}</span></div>`;
    }).join('');
}

function updateLobbyList() {
    $('lobbyPlayerList').innerHTML = GameState.players.map(p => `<div class="player-tag ${p.id === GameState.players[0]?.id ? 'active' : ''}">${p.name}</div>`).join('');
    $('playerCount').textContent = GameState.players.length;
}

function getCurrentPlayer() { return GameState.players[GameState.currentPlayerIndex]; }
function getMyPlayer() { return GameState.players.find(p => p.id === peerManager.myId); }
function amIHost() { return peerManager.isHost; }
function getActivePlayers() { return GameState.players.filter(p => !p.eliminated); }
function broadcastState() { if (amIHost()) peerManager.broadcast({ type: 'PLAYER_LIST', players: GameState.players }); }

// =====================
// NETWORK HANDLERS
// =====================
peerManager.onMessageCallback = (data, from) => {
    if (amIHost()) {
        if (data.type === 'THEME_SUBMIT') handleThemeSubmit(data, from);
        else if (data.type === 'CHARACTER_SUBMIT') { handleCharacterSubmit(data); peerManager.broadcast(data); }
        else if (data.type === 'VOTE_SUBMIT') handleVoteSubmit(data);
        else if (data.type === 'PLAYER_ELIMINATED') { handlePlayerEliminated(data); setTimeout(() => checkGameEnd(), 500); }
        else if (data.type === 'LEGEND_SUBMIT') { handleLegendSubmit(data); peerManager.broadcast(data); }
        else if (data.type === 'GAME_OVER') { handleGameOver(data); peerManager.broadcast(data); }
    } else {
        if (data.type === 'PLAYER_LIST') handlePlayerList(data);
        else if (data.type === 'GAME_START') handleGameStart(data);
        else if (data.type === 'THEME_DECIDED') handleThemeDecided(data);
        else if (data.type === 'NEW_TURN') handleNewTurn(data);
        else if (data.type === 'CHARACTER_SUBMIT') handleCharacterSubmit(data);
        else if (data.type === 'TURN_RESULT') handleTurnResult(data);
        else if (data.type === 'PLAYER_ELIMINATED') handlePlayerEliminated(data);
        else if (data.type === 'LEGEND_MODE') handleLegendMode(data);
        else if (data.type === 'GAME_OVER') handleGameOver(data);
    }
};

peerManager.onConnectionCallback = (pid, name) => {
    if (amIHost()) {
        GameState.players.push({ id: pid, name, score: 0, eliminated: false });
        broadcastState();
        updateLobbyList();
        $('startGameBtn').disabled = GameState.players.length < 2;
        showToast(`${name} a rejoint`);
    }
};

peerManager.onDisconnectionCallback = (pid) => { 
    const p = GameState.players.find(p => p.id === pid); 
    if (p) { 
        p.eliminated = true; 
        showToast(`${p.name} a quitté`, 'warning'); 
        broadcastState(); 
        updateHeaderPlayers();
        if (getCurrentPlayer() && getCurrentPlayer().id === pid) {
            if(amIHost()) nextTurnLogic(); 
        }
        if (amIHost()) checkGameEnd(); 
    } 
};

// =====================
// GAME LOGIC
// =====================

function handlePlayerList(data) { GameState.players = data.players; updateLobbyList(); updateHeaderPlayers(); }

function handleGameStart(data) {
    GameState.players = data.players;
    $('gameHeader').classList.remove('hidden');
    updateHeaderPlayers();
    initThemePhase();
}

function initThemePhase() {
    GameState.phase = 'theme';
    GameState.themeProposals = {};
    $('themeInput').value = '';
    $('themeWaiting').classList.add('hidden');
    $('submitThemeBtn').disabled = false;
    showScreen('theme');
}

function handleThemeSubmit(data, from) {
    if (!amIHost()) return;
    GameState.themeProposals[from] = data.theme;
    const active = getActivePlayers().map(p => p.id);
    if (Object.keys(GameState.themeProposals).filter(id => active.includes(id)).length === active.length) {
        const ids = Object.keys(GameState.themeProposals);
        const chosen = GameState.themeProposals[ids[Math.floor(Math.random() * ids.length)]];
        peerManager.broadcast({ type: 'THEME_DECIDED', theme: chosen, players: GameState.players });
        handleThemeDecided({ theme: chosen, players: GameState.players });
    }
}

function handleThemeDecided(data) {
    GameState.currentTheme = data.theme;
    GameState.players = data.players;
    GameState.currentPlayerIndex = GameState.players.findIndex(p => !p.eliminated);
    GameState.isLastChance = false;
    GameState.phase = 'input';
    $('revealedThemeText').textContent = GameState.currentTheme;
    showScreen('themeReveal');
    setTimeout(() => { updateHeaderPlayers(); showTurnScreen(); }, 3000);
}

function handleNewTurn(data) {
    GameState.currentPlayerIndex = data.currentPlayerIndex;
    GameState.isLastChance = false;
    GameState.phase = 'input';
    GameState.votes = {};
    updateHeaderPlayers();
    showTurnScreen();
}

function showTurnScreen() {
    const current = getCurrentPlayer();
    
    // Reset UI
    $('characterInput').value = '';
    $('lastChanceWarning').classList.add('hidden');
    $('votingCharacterDisplay').classList.remove('last-chance', 'legend');

    if (!current || current.eliminated) { if(amIHost()) nextTurnLogic(); return; }

    if (current.id === peerManager.myId) {
        $('inputThemeBadge').textContent = `Thème: ${GameState.currentTheme}`;
        $('inputPlayerName').textContent = current.name;
        if (GameState.isLastChance) $('lastChanceWarning').classList.remove('hidden');
        showScreen('input');
    } else {
        $('waitingThemeBadge').textContent = `Thème: ${GameState.currentTheme}`;
        $('waitingPlayerName').textContent = current.name;
        $('waitingForName').textContent = current.name;
        showScreen('waiting');
    }
}

function handleCharacterSubmit(data) {
    GameState.currentCharacter = data.character;
    GameState.currentAuthorId = data.authorId;
    GameState.votes = {};
    GameState.phase = 'vote';
    GameState.isLegendRound = data.isLegend || false;

    const author = GameState.players.find(p => p.id === data.authorId);
    
    $('votingAuthor').textContent = author.name;
    $('characterNameDisplay').textContent = data.character;
    $('yesCount').textContent = '0'; $('noCount').textContent = '0';
    $('voteProgress').style.width = '0%';
    $('voteButtons').classList.remove('hidden');
    $('voteWaitingMessage').classList.add('hidden');
    $('spectatorMessage').classList.add('hidden');
    $('votingCharacterDisplay').classList.remove('last-chance', 'legend');
    
    if(GameState.isLegendRound) $('votingCharacterDisplay').classList.add('legend');
    else if(GameState.isLastChance) $('votingCharacterDisplay').classList.add('last-chance');

    showScreen('voting');

    const me = getMyPlayer();
    const isAuthor = (data.authorId === peerManager.myId);
    const canVote = GameState.isLegendRound ? !isAuthor : (!isAuthor && !me.eliminated);

    if (isAuthor) {
        $('voteButtons').classList.add('hidden');
        $('voteWaitingMessage').classList.remove('hidden');
    } else if (!canVote) {
        $('voteButtons').classList.add('hidden');
        $('spectatorMessage').classList.remove('hidden');
    } else {
        $('voteYesBtn').disabled = false;
        $('voteNoBtn').disabled = false;
    }
}

function handleVoteSubmit(data) {
    GameState.votes[data.voterId] = data.vote;
    let yes = 0, no = 0;
    Object.values(GameState.votes).forEach(v => v === 'yes' ? yes++ : no++);
    $('yesCount').textContent = yes; $('noCount').textContent = no;

    let totalNeeded = GameState.isLegendRound ? GameState.players.filter(p => p.id !== GameState.currentAuthorId).length : getActivePlayers().filter(p => p.id !== GameState.currentAuthorId).length;
    
    $('voteProgress').style.width = (Object.keys(GameState.votes).length / totalNeeded * 100) + '%';
    updateHeaderPlayers();

    if (Object.keys(GameState.votes).length >= totalNeeded && amIHost()) {
        setTimeout(calculateResult, 1000);
    }
}

function handlePlayerEliminated(data) {
    const p = GameState.players.find(p => p.id === data.playerId);
    if (p) {
        p.eliminated = true;
        showToast(`${p.name} éliminé !`, 'error');
        broadcastState();
        updateHeaderPlayers();
    }
}

function calculateResult() {
    let yes = 0, no = 0;
    Object.values(GameState.votes).forEach(v => v === 'yes' ? yes++ : no++);
    const accepted = yes > no;
    const author = GameState.players.find(p => p.id === GameState.currentAuthorId);
    
    let resultData = {
        type: 'TURN_RESULT', character: GameState.currentCharacter, author: author?.name || '?',
        yes, no, accepted, players: GameState.players,
        isLastChance: false, isEliminated: false, isLegendRound: GameState.isLegendRound
    };

    if (GameState.isLegendRound) {
        handleTurnResult(resultData); peerManager.broadcast(resultData);
        setTimeout(() => { handleGameOver({ players: GameState.players }); peerManager.broadcast({ type: 'GAME_OVER', players: GameState.players }); }, 3000);
        return;
    }

    if (!accepted) {
        if (!GameState.isLastChance) {
            GameState.isLastChance = true;
            resultData.isLastChance = true;
        } else {
            handlePlayerEliminated({ playerId: author.id });
            resultData.isEliminated = true;
        }
    } else {
        if (author) author.score += yes;
    }

    if(!resultData.isLastChance) GameState.isLastChance = false;

    handleTurnResult(resultData); peerManager.broadcast(resultData);
    if (!resultData.isLastChance) setTimeout(() => { if(amIHost()) checkGameEnd(); }, 2500);
}

function handleTurnResult(data) {
    GameState.players = data.players; GameState.phase = 'result';
    $('resultCharacterName').textContent = data.character; $('resultAuthor').textContent = data.author;
    $('resultYesCount').textContent = data.yes; $('resultNoCount').textContent = data.no;
    $('resultCharacterDisplay').classList.remove('last-chance', 'legend');
    
    if (data.isLegendRound) {
        $('resultMessage').textContent = data.accepted ? "LÉGENDE !" : "Refusé...";
        $('resultCharacterDisplay').classList.add('legend');
    } else if (data.isLastChance) {
        $('resultMessage').textContent = 'Refusé ! Dernière chance...';
        $('resultMessage').style.color = 'var(--warning)';
        $('resultCharacterDisplay').classList.add('last-chance');
        setTimeout(() => { GameState.phase = 'input'; showTurnScreen(); }, 2000);
        return;
    } else {
        $('resultMessage').textContent = data.accepted ? 'Accepté !' : (data.isEliminated ? 'Refusé ! Éliminé.' : 'Refusé.');
        $('resultMessage').style.color = data.accepted ? 'var(--accent)' : 'var(--danger)';
    }

    updateHeaderPlayers();
    showScreen('result');
}

function checkGameEnd() {
    const active = getActivePlayers();
    if (active.length === 1) {
        const data = { type: 'LEGEND_MODE', winnerId: active[0].id, players: GameState.players };
        peerManager.broadcast(data); handleLegendMode(data);
    } else if (active.length === 0) {
        handleGameOver({ players: GameState.players }); peerManager.broadcast({ type: 'GAME_OVER', players: GameState.players });
    } else {
        nextTurnLogic();
    }
}

function handleLegendMode(data) {
    GameState.phase = 'legend';
    if (peerManager.myId === data.winnerId) showScreen('legendInput');
    else {
        $('waitingPlayerName').textContent = "Le gagnant";
        $('waitingForName').textContent = "légende";
        showScreen('waiting');
    }
}

function handleLegendSubmit(data) {
    handleCharacterSubmit({ character: data.character, authorId: data.authorId, isLegend: true });
}

function nextTurnLogic() {
    let nextIdx = GameState.currentPlayerIndex;
    let loopSafety = 0;
    
    // Find next non-eliminated player
    do {
        nextIdx = (nextIdx + 1) % GameState.players.length;
        loopSafety++;
    } while (GameState.players[nextIdx].eliminated && loopSafety < GameState.players.length + 1);

    if (GameState.players[nextIdx].eliminated) { checkGameEnd(); return; }

    const data = { type: 'NEW_TURN', currentPlayerIndex: nextIdx, players: GameState.players };
    peerManager.broadcast(data);
    handleNewTurn(data);
}

function handleGameOver(data) {
    GameState.players = data.players; GameState.phase = 'gameover';
    const sorted = [...GameState.players].sort((a, b) => b.score - a.score);
    $('finalScores').innerHTML = sorted.map((p, i) => `
        <div class="score-item ${i === 0 ? 'winner' : ''} ${p.eliminated ? 'dead' : ''}">
            <div class="flex items-center gap-3">
                <span class="font-display text-xl font-bold ${i === 0 ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}">#${i + 1}</span>
                <span class="font-medium">${p.name}</span>
            </div>
            <span class="font-display text-xl font-bold">${p.score} pts</span>
        </div>
    `).join('');
    showScreen('gameover');
}

// =====================
// UI EVENTS
// =====================

 $('createRoomBtn').addEventListener('click', async () => {
    const name = $('playerNameInput').value.trim();
    if (!name) { showToast("Entre un nom d'abord !", 'error'); return; }
    try {
        const id = await peerManager.createRoom(name);
        GameState.players = [{ id: peerManager.myId, name, score: 0, eliminated: false }];
        $('roomCodeDisplay').textContent = id;
        updateLobbyList(); showScreen('lobby');
    } catch (e) { showToast(e.message || "Erreur création salle", 'error'); }
});

 $('joinRoomBtn').addEventListener('click', async () => {
    const name = $('playerNameInput').value.trim();
    const code = $('joinRoomInput').value.trim().toUpperCase();
    if (!name) { showToast("Entre un nom !", 'error'); return; }
    if (!code) { showToast("Entre un code !", 'error'); return; }
    try {
        await peerManager.joinRoom(code, name);
        GameState.players = [{ id: peerManager.myId, name, score: 0, eliminated: false }];
        $('roomCodeDisplay').textContent = code;
        updateLobbyList(); showScreen('lobby');
    } catch (e) { showToast("Salle introuvable", 'error'); }
});

 $('startGameBtn').addEventListener('click', () => {
    if (!amIHost() || GameState.players.length < 2) return;
    peerManager.broadcast({ type: 'GAME_START', players: GameState.players });
    $('gameHeader').classList.remove('hidden');
    updateHeaderPlayers(); initThemePhase();
});

 $('submitThemeBtn').addEventListener('click', () => {
    const theme = $('themeInput').value.trim();
    if (!theme) return;
    $('submitThemeBtn').disabled = true;
    $('themeWaiting').classList.remove('hidden');
    if (amIHost()) handleThemeSubmit({ type: 'THEME_SUBMIT', theme }, peerManager.myId);
    else peerManager.sendToHost({ type: 'THEME_SUBMIT', theme });
});

 $('submitCharacterBtn').addEventListener('click', () => {
    const char = $('characterInput').value.trim();
    if (!char) return;
    const data = { type: 'CHARACTER_SUBMIT', character: char, authorId: peerManager.myId };
    handleCharacterSubmit(data);
    if (amIHost()) peerManager.broadcast(data);
    else peerManager.sendToHost(data);
});

 $('passTurnBtn').addEventListener('click', () => {
    if (confirm("Abandonner ?")) {
        const data = { type: 'PLAYER_ELIMINATED', playerId: peerManager.myId };
        if (amIHost()) {
            handlePlayerEliminated(data);
            setTimeout(() => checkGameEnd(), 500);
        } else {
            peerManager.sendToHost(data);
            showScreen('waiting');
        }
    }
});

 $('voteYesBtn').addEventListener('click', () => submitVote('yes'));
 $('voteNoBtn').addEventListener('click', () => submitVote('no'));

function submitVote(vote) {
    const data = { type: 'VOTE_SUBMIT', voterId: peerManager.myId, vote };
    if (amIHost()) handleVoteSubmit(data);
    else peerManager.sendToHost(data);
    
    $('voteYesBtn').disabled = true;
    $('voteNoBtn').disabled = true;
    $('voteButtons').classList.add('hidden');
    $('voteWaitingMessage').classList.remove('hidden');
}

 $('submitLegendBtn').addEventListener('click', () => {
    const char = $('legendInput').value.trim();
    if (!char) return;
    const data = { type: 'LEGEND_SUBMIT', character: char, authorId: peerManager.myId };
    if (amIHost()) { handleLegendSubmit(data); peerManager.broadcast(data); }
    else peerManager.sendToHost(data);
});

 $('endGameSimpleBtn').addEventListener('click', () => {
    const data = { type: 'GAME_OVER', players: GameState.players };
    handleGameOver(data);
    if (amIHost()) peerManager.broadcast(data);
    else peerManager.sendToHost(data);
});

 $('leaveRoomBtn').addEventListener('click', () => { peerManager.disconnect(); location.reload(); });

// Enter keys handling
['playerNameInput', 'joinRoomInput', 'characterInput', 'themeInput', 'legendInput'].forEach(id => {
    $(id).addEventListener('keypress', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.target.nextElementSibling?.click() || e.target.parentElement.querySelector('button')?.click();
        }
    });
});