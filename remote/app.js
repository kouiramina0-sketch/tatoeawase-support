(() => {
  const config = window.TATOEAWASE_FIREBASE_CONFIG || {};
  const els = Object.fromEntries([
    'joinCard','roomCode','displayName','joinButton','waitingCard','roomCodeView',
    'waitingStatus','answerCard','roundLabel','topicTitle','choices','answerHint',
    'submittedCard','changeAnswerButton','closedCard','errorCard','errorText'
  ].map(id => [id, document.getElementById(id)]));

  const state = {
    session: null,
    roomId: null,
    roomCode: null,
    participantId: null,
    currentRoundNumber: null,
    selectedChoice: null,
    submittedRoundNumber: null,
    pollTimer: null,
    lastStatus: null,
  };

  const q = new URLSearchParams(location.search);
  const prefilledRoom = (q.get('room') || '').trim().toUpperCase();
  if (prefilledRoom) els.roomCode.value = prefilledRoom.slice(0, 6);

  function showOnly(id) {
    for (const key of ['joinCard','waitingCard','answerCard','submittedCard','closedCard']) {
      els[key].classList.toggle('hidden', key !== id);
    }
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.errorCard.classList.remove('hidden');
  }

  function clearError() {
    els.errorCard.classList.add('hidden');
  }

  function requireConfig() {
    if (!config.apiKey || !config.databaseUrl ||
        config.apiKey.startsWith('__') || config.databaseUrl.startsWith('__')) {
      throw new Error('リモート参加は現在準備中です。');
    }
  }

  async function authAnonymous() {
    requireConfig();
    const res = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' +
        encodeURIComponent(config.apiKey),
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({returnSecureToken:true}),
      }
    );
    if (!res.ok) throw new Error('接続の準備に失敗しました。');
    const data = await res.json();
    state.session = {
      uid: data.localId,
      idToken: data.idToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + Number(data.expiresIn || 3600) * 1000,
    };
    state.participantId = data.localId;
  }

  function pathUrl(path) {
    const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return config.databaseUrl.replace(/\/+$/,'') + '/' + clean + '.json?auth=' +
      encodeURIComponent(state.session.idToken);
  }

  async function db(path, method='GET', body) {
    const res = await fetch(pathUrl(path), {
      method,
      headers: body === undefined ? undefined : {'Content-Type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error('ルームとの通信に失敗しました。');
    const text = await res.text();
    return !text || text === 'null' ? null : JSON.parse(text);
  }

  async function join() {
    clearError();
    els.joinButton.disabled = true;
    try {
      const code = els.roomCode.value.trim().toUpperCase();
      const name = els.displayName.value.trim().replace(/\s+/g,' ').slice(0,12);
      if (code.length !== 6) throw new Error('6文字のルームコードを入力してください。');
      if (!name) throw new Error('名前を入力してください。');

      if (!state.session) await authAnonymous();
      const roomId = await db('roomCodes/' + code);
      if (!roomId) throw new Error('ルームが見つかりません。');

      const meta = await db('rooms/' + roomId + '/meta');
      if (!meta || meta.expiresAt <= Date.now() || meta.status === 'closed') {
        throw new Error('このルームは終了しています。');
      }
      if (meta.locked || meta.status !== 'lobby') {
        throw new Error('このルームはすでに開始されています。');
      }

      const members = (await db('rooms/' + roomId + '/members')) || {};
      if (Object.keys(members).length >= 8 && !members[state.session.uid]) {
        throw new Error('このルームは満員です。');
      }

      const participant = {
        id: state.session.uid,
        name,
        joinedAt: Date.now(),
        connected: true,
      };
      await db('rooms/' + roomId + '/members/' + state.session.uid, 'PUT', participant);

      state.roomId = roomId;
      state.roomCode = code;
      els.roomCodeView.textContent = code;
      history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(code));
      showOnly('waitingCard');
      startPolling();
    } catch (err) {
      showError(err instanceof Error ? err.message : '参加に失敗しました。');
    } finally {
      els.joinButton.disabled = false;
    }
  }

  function renderRound(round) {
    if (!round) return;
    state.currentRoundNumber = round.roundNumber;
    state.selectedChoice = null;
    els.roundLabel.textContent = '第' + round.roundNumber + '問';
    els.topicTitle.textContent = round.title;
    els.choices.innerHTML = '';

    for (const choice of round.choices || []) {
      const button = document.createElement('button');
      button.className = 'choice';
      button.type = 'button';
      button.dataset.choiceIndex = String(choice.index);
      button.innerHTML =
        '<div>' + escapeHtml(choice.displayLabel || choice.label) + '</div>';
      button.addEventListener('click', () => submitAnswer(choice.index, button));
      els.choices.appendChild(button);
    }

    showOnly('answerCard');
  }

  async function submitAnswer(choiceIndex, button) {
    clearError();
    if (!state.roomId || state.currentRoundNumber == null) return;

    for (const node of els.choices.querySelectorAll('.choice')) {
      node.classList.remove('selected');
      node.disabled = true;
    }
    button.classList.add('selected');

    try {
      await db(
        'rooms/' + state.roomId + '/answers/' + state.participantId,
        'PUT',
        {
          choiceIndex,
          roundNumber: state.currentRoundNumber,
          submittedAt: Date.now(),
        }
      );
      state.selectedChoice = choiceIndex;
      state.submittedRoundNumber = state.currentRoundNumber;
      showOnly('submittedCard');
    } catch (err) {
      for (const node of els.choices.querySelectorAll('.choice')) node.disabled = false;
      showError(err instanceof Error ? err.message : '回答を送信できませんでした。');
    }
  }

  function allowAnswerChange() {
    if (state.lastStatus !== 'answering') return;
    showOnly('answerCard');
    for (const node of els.choices.querySelectorAll('.choice')) node.disabled = false;
  }

  async function poll() {
    if (!state.roomId) return;
    try {
      const [meta, round, member] = await Promise.all([
        db('rooms/' + state.roomId + '/meta'),
        db('rooms/' + state.roomId + '/round'),
        db('rooms/' + state.roomId + '/members/' + state.participantId),
      ]);

      if (!meta || !member || meta.expiresAt <= Date.now() || meta.status === 'closed') {
        stopPolling();
        showOnly('closedCard');
        return;
      }

      state.lastStatus = meta.status;

      if (meta.status === 'lobby') {
        els.waitingStatus.textContent = meta.locked
          ? '参加を締め切りました。開始を待っています'
          : 'ホストの開始を待っています';
        showOnly('waitingCard');
        return;
      }

      if (meta.status === 'answering' && round) {
        if (state.currentRoundNumber !== round.roundNumber) {
          state.submittedRoundNumber = null;
          renderRound(round);
          return;
        }
        if (state.submittedRoundNumber === round.roundNumber) {
          showOnly('submittedCard');
          return;
        }
        showOnly('answerCard');
        return;
      }

      if (['group','reveal','result'].includes(meta.status)) {
        els.waitingStatus.textContent =
          meta.status === 'group'
            ? 'みんなで予想中です'
            : meta.status === 'reveal'
              ? 'REVEAL中です 👀'
              : '結果を見ています';
        showOnly('waitingCard');
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : '通信が不安定です。再接続します。');
    }
  }

  function startPolling() {
    stopPolling();
    poll();
    state.pollTimer = setInterval(poll, 1500);
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  els.joinButton.addEventListener('click', join);
  els.changeAnswerButton.addEventListener('click', allowAnswerChange);

  window.addEventListener('pagehide', () => {
    if (!state.roomId || !state.session) return;
    fetch(pathUrl('rooms/' + state.roomId + '/members/' + state.participantId + '/connected'), {
      method:'PUT',
      headers:{'Content-Type':'application/json'},
      body:'false',
      keepalive:true,
    }).catch(() => {});
  });
})();
