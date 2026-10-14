(() => {
  const config = window.TATOEAWASE_FIREBASE_CONFIG || {};
  const codeInput = document.getElementById('roomCode');
  const logEl = document.getElementById('log');
  const joinBtn = document.getElementById('joinBots');
  const answerBtn = document.getElementById('answerBots');
  const leaveBtn = document.getElementById('leaveBots');

  const bots = [];

  function log(message) {
    logEl.textContent = message;
  }

  function baseUrl() {
    return config.databaseUrl.replace(/\/+$/, '');
  }

  async function anon() {
    const res = await fetch(
      'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' +
        encodeURIComponent(config.apiKey),
      {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({returnSecureToken:true}),
      }
    );
    if (!res.ok) throw new Error('匿名認証に失敗: ' + res.status);
    const data = await res.json();
    return {uid:data.localId,idToken:data.idToken};
  }

  async function db(session, path, method='GET', body) {
    const clean = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const url = baseUrl() + '/' + clean + '.json?auth=' +
      encodeURIComponent(session.idToken);
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : {'Content-Type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(method + ' ' + path + ' failed: ' + res.status + ' ' + text.slice(0,120));
    }
    const text = await res.text();
    return !text || text === 'null' ? null : JSON.parse(text);
  }

  async function resolveRoom(session) {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 6) throw new Error('6文字のルームコードを入力してください');
    const roomId = await db(session, 'roomCodes/' + code);
    if (!roomId) throw new Error('ルームが見つかりません');
    return {code,roomId};
  }

  joinBtn.onclick = async () => {
    joinBtn.disabled = true;
    try {
      bots.length = 0;
      for (let i=0;i<2;i++) {
        const session = await anon();
        const {roomId} = await resolveRoom(session);
        const meta = await db(session, 'rooms/' + roomId + '/meta');
        if (!meta || meta.status !== 'lobby' || meta.locked) {
          throw new Error('ルームは参加受付中ではありません');
        }
        const participant = {
          id:session.uid,
          name:'QA-Bot' + (i+1),
          joinedAt:Date.now()+i,
          connected:true,
        };
        await db(session, 'rooms/' + roomId + '/members/' + session.uid, 'PUT', participant);
        bots.push({...session,roomId});
      }
      log('疑似ゲスト2人を追加しました。\nホストアプリへ戻ってゲームを開始してください。');
    } catch (e) {
      log('ERROR: ' + (e?.message || e));
    } finally {
      joinBtn.disabled = false;
    }
  };

  answerBtn.onclick = async () => {
    answerBtn.disabled = true;
    try {
      if (bots.length !== 2) throw new Error('先に疑似ゲスト2人を追加してください');
      const details = [];
      for (let i=0;i<bots.length;i++) {
        const bot = bots[i];
        const meta = await db(bot, 'rooms/' + bot.roomId + '/meta');
        const round = await db(bot, 'rooms/' + bot.roomId + '/round');
        if (!meta || meta.status !== 'answering' || !round) {
          throw new Error('まだ回答受付中ではありません');
        }
        const choices = round.choices || [];
        if (!choices.length) throw new Error('選択肢がありません');
        const selected = choices[Math.min(i, choices.length-1)].index;
        await db(bot, 'rooms/' + bot.roomId + '/answers/' + bot.uid, 'PUT', {
          choiceIndex:selected,
          roundNumber:round.roundNumber,
          submittedAt:Date.now(),
        });
        details.push('QA-Bot' + (i+1) + ': choice ' + selected);
      }
      log('疑似ゲストの回答送信完了。\n' + details.join('\n') + '\nホストアプリへ戻ってください。');
    } catch (e) {
      log('ERROR: ' + (e?.message || e));
    } finally {
      answerBtn.disabled = false;
    }
  };

  leaveBtn.onclick = async () => {
    leaveBtn.disabled = true;
    try {
      for (const bot of bots) {
        await db(bot, 'rooms/' + bot.roomId + '/members/' + bot.uid, 'DELETE');
      }
      bots.length = 0;
      log('疑似ゲストを退出させました');
    } catch (e) {
      log('ERROR: ' + (e?.message || e));
    } finally {
      leaveBtn.disabled = false;
    }
  };
})();