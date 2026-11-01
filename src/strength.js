/* Dex_QR — passphrase strength estimate (cycle 4). Original code, MIT License. No third-party code or data.
 *
 * Idea: an attacker does not try characters uniformly; they try common passwords, words, keyboard runs,
 * sequences, repeats and years first. So the passphrase is split into pieces, each piece is priced at the
 * number of bits an attacker who guesses that kind of piece would need, and the cheapest split wins
 * (dynamic programming over positions). The result is an estimate of log2(guesses), a hint, not a guarantee.
 *
 * Pieces and their prices (bits):
 *   common      a word from the built-in list below (ranked; most common first): log2(rank) + case + leet (+1 reversed)
 *   word        a whole word-like run: 3–12 letters (at most 2 leet substitutes), lower, Capitalised or UPPER,
 *               vowel share >= 25%, no 4 consonants in a row, >= 60% of letter pairs common in English:
 *               min(13 per started 8 letters + case + leet, random price). 13 bits ~ one diceware word (7,776).
 *   sequence    abc, 9876, ZYX (step +1 or -1): log2(alphabet) + log2(length) (+1 descending)
 *   keyboard    qwerty, asdf, zxcvbnm, 12345 on a US keyboard row: log2(47) + log2(length) (+1 leftwards)
 *   repeat      a block repeated k times (aaaa, abcabc): price(block) + log2(k)
 *   year        1900–2039: log2(140)
 *   separator   the passphrase's first separator (space - _ . , + /) costs log2(7) once; repeats of it are free
 *   random      any one character: log2(pool), pool = 26 lower + 26 upper + 10 digits + 33 ASCII symbols
 *               + 100 for other characters, counting only the classes present in the whole passphrase
 * Nothing here returns pieces of the passphrase itself, so a page can show the warnings on a screen that may
 * be filmed (the sender's) without leaking parts of it.
 */
(function (root) {
  "use strict";
  // Built-in list, written for Dex_QR: widely known weak passwords and words people build passwords from,
  // roughly most common first. Lowercase, leet-free; matching undoes case and common leet substitutions.
  const COMMON = (
    "password 123456 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football " +
    "monkey letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890 michael 654321 superman " +
    "1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter buster " +
    "soccer harley batman andrew tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel starwars " +
    "klaster 112233 george computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass " +
    "maggie 159753 aaaaaa ginger princess joshua cheese amanda summer love ashley nicole chelsea biteme matthew " +
    "access yankees 987654321 dallas austin thunder taylor matrix minecraft william corvette hello martin heather " +
    "secret merlin diamond 1234qwer hammer silver 222222 88888888 anthony justin test bailey q1w2e3r4t5 " +
    "patrick internet scooter orange 11111 golfer cookie richard samantha bigdog guitar jackson whatever mickey " +
    "chicken sparky snoopy maverick phoenix camaro peanut morgan welcome falcon cowboy ferrari samsung andrea " +
    "smokey steelers joseph mercedes dakota arsenal eagles melissa boomer booboo spider nascar monster tigers " +
    "yellow xxxxxx 123123123 gateway marina diablo bulldog qwer1234 compaq purple hardcore banana junior hannah " +
    "123654 porsche lakers iceman money cowboys 987654 london tennis 999999 ncc1701 coffee scooby 0000 miller " +
    "boston q1w2e3r4 brandon yamaha chester mother forever johnny edward 333333 oliver redsox player nikita " +
    "knight fender barney midnight please brandy chicago badboy slayer rangers charles angel flower bigdaddy " +
    "rabbit wizard jasper enter rachel chris steven winner adidas victoria natasha 1q2w3e4r jasmine winter prince " +
    "panties marine fishing cocacola casper james 232323 raiders 888888 marlboro gandalf asdfasdf crystal " +
    "87654321 12344321 golden 8675309 panther lauren angela spring autumn admin administrator login " +
    "changeme default guest root user iloveu loveme lovely blessed jesus heaven family friends happy lucky " +
    "beautiful sweet pokemon spiderman liverpool barcelona madrid juventus rainbow butterfly dolphin chocolate " +
    "apple google iphone android facebook azerty qwertz passw0rd letmein1 welcome1 monday friday sunday " +
    "january october december dexter smudge"
  ).split(" ");
  const RANK = new Map();
  COMMON.forEach((w, i) => { if (!RANK.has(w)) RANK.set(w, i + 1); });
  const MAX_WORD = 20;
  const LEET = { "4": "a", "@": "a", "8": "b", "(": "c", "3": "e", "6": "g", "1": "i", "!": "i", "|": "i", "0": "o", "$": "s", "5": "s", "7": "t", "+": "t", "2": "z" };
  const ROWS = ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"];
  const ROW_OF = new Map();
  ROWS.forEach((r, ri) => { for (let i = 0; i < r.length; i++) ROW_OF.set(r[i], [ri, i]); });
  // Letter pairs that are common in English words, roughly most frequent first (written for Dex_QR). A run counts
  // as word-like only if at least 60% of its adjacent pairs are in this set, which random letters rarely manage.
  const BIGRAMS = new Set("th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng se ha as ou io le ve co me de hi ri ro ic ne ea ra ce li ch ll be ma si om ur ca el ta la ns di fo ho pe ec pr no ct us ac ot il tr ly nc et ut ss so rs un lo wa ge ie wh ee wi em ad ol rt po we na ul ni ts mo ow pa im mi ai sh ir su id os iv ia am fi ci vi pl ig tu ev ld ry mp fe bl ab gh ty op wo sa ay ex ke fr oo av ag if ap gr od bo sp rd do uc bu ei ov by rm ep tt oc fa ef cu rn sc gi da yo cr cl du ga qu ue ff ba ey ls va um pp ua up lu go ht ru ug ds lt pi rc rr eg au ck ew mu br bi pt ak pu ui rg ib tl ny ki rk ys ob mm fu ph og ms ye ud mb ip ub oi rl gu dr hr cc tw ft wn nu af hu nn eo vo rv nf xp gn sm fl iz ok nl my gl aw ju oa eq sy sl ps jo lf nv je nk kn gs dy hy ze ks xt bs ik dd cy rp sk xi oe oy ws".split(" "));
  const SEPARATORS = " -_.,+/";
  const MAX_LEN = 256;               // longer input: the first 256 characters are analysed, the rest priced as random
  const log2 = Math.log2;

  const isLower = (c) => c >= "a" && c <= "z";
  const isUpper = (c) => c >= "A" && c <= "Z";
  const isDigit = (c) => c >= "0" && c <= "9";
  const isAsciiSym = (c) => c.length === 1 && c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7f && !isLower(c) && !isUpper(c) && !isDigit(c);
  function poolOf(chars) {
    let lo = 0, up = 0, dg = 0, sy = 0, ot = 0;
    for (const c of chars) { if (isLower(c)) lo = 26; else if (isUpper(c)) up = 26; else if (isDigit(c)) dg = 10; else if (isAsciiSym(c)) sy = 33; else ot = 100; }
    return Math.max(10, lo + up + dg + sy + ot);
  }
  function binom(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }
  /* Bits for the capitalisation of a piece: none 0, all caps or first letter only 1, else log2 of the ways. */
  function caseBits(chars) {
    let up = 0, lo = 0;
    for (const c of chars) { if (isUpper(c)) up++; else if (isLower(c)) lo++; }
    if (!up) return 0;
    if (!lo || (up === 1 && isUpper(chars[0]))) return 1;
    let ways = 0; const n = up + lo, k = Math.min(up, lo);
    for (let i = 1; i <= k; i++) ways += binom(n, i);
    return log2(ways);
  }
  /* Undo leet: returns {text, subs} or null if a character is neither a letter nor a known substitute. */
  function unleet(chars, oneAs) {
    let text = "", subs = 0;
    for (const c of chars) {
      const l = c.toLowerCase();
      if (isLower(l) || isDigit(l)) { text += l; continue; }
      const m = c === "1" ? oneAs : LEET[c];
      if (!m) return null;
      text += m; subs++;
    }
    return { text, subs };
  }
  function lettersFromLeet(chars, oneAs) {
    let text = "", subs = 0;
    for (const c of chars) {
      if (isLower(c) || isUpper(c)) { text += c.toLowerCase(); continue; }
      const m = c === "1" ? oneAs : LEET[c];
      if (!m) return null;
      text += m; subs++;
    }
    return { text, subs };
  }
  function looksLikeWord(w) {
    if (w.length < 3 || w.length > 12) return false;
    let v = 0, run = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w[i];
      if ("aeiouy".includes(c)) { v++; run = 0; } else if (++run >= 4) return false;
      if (i >= 2 && c === w[i - 1] && c === w[i - 2]) return false;
    }
    if (v / w.length < 0.25) return false;
    let common = 0;
    for (let i = 0; i + 1 < w.length; i++) if (BIGRAMS.has(w.slice(i, i + 2))) common++;
    return common / (w.length - 1) >= 0.6;
  }
  /* lower, Capitalised or UPPER: how people write words. Random mixed case is not word-like. */
  function wordCase(chars) {
    const letters = chars.filter((c) => isLower(c) || isUpper(c));
    if (letters.every(isLower) || letters.every(isUpper)) return true;
    return isUpper(letters[0]) && letters.slice(1).every(isLower);
  }

  const memo = new Map();
  /* Cheapest split of chars[0..n) into pieces. Returns {bits, parts:[{kind, start, end, bits}]} */
  function analyse(chars, pool, topLevel) {
    const key = topLevel ? null : pool + "\u0000" + chars.join("");
    if (key !== null && memo.has(key)) return memo.get(key);
    const n = chars.length;
    const rnd = log2(pool);
    const best = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1), how = new Array(n + 1);
    best[0] = 0;
    const firstSep = chars.findIndex((c) => SEPARATORS.includes(c));
    const offer = (i, j, bits, kind) => { const b = best[i] + bits; if (b < best[j] - 1e-9) { best[j] = b; from[j] = i; how[j] = { kind, bits }; } };
    // Word-like runs: maximal runs of letters (and leet substitutes), split at lower->Upper (camelCase) boundaries.
    const wordEnds = new Map();
    {
      const isW = (c) => isLower(c) || isUpper(c) || c in LEET;
      let i = 0;
      while (i < n) {
        if (!isW(chars[i])) { i++; continue; }
        let j = i + 1;
        while (j < n && isW(chars[j]) && !(isUpper(chars[j]) && isLower(chars[j - 1]))) j++;
        wordEnds.set(i, j);
        i = j;
      }
    }
    for (let i = 0; i < n; i++) {
      if (best[i] === Infinity) continue;
      const c = chars[i];
      // random character, or a free repeat of the passphrase's separator
      if (SEPARATORS.includes(c) && firstSep >= 0 && c === chars[firstSep]) offer(i, i + 1, i === firstSep ? log2(SEPARATORS.length) : 0, "separator");
      offer(i, i + 1, rnd, "random");
      // common-list words (4+ characters, or the whole input), straight or reversed, with case and leet
      for (let j = i + 3; j <= Math.min(n, i + MAX_WORD); j++) {
        if (j - i < 4 && !(i === 0 && j === n)) continue;
        const piece = chars.slice(i, j);
        for (const oneAs of ["i", "l"]) {
          const u = unleet(piece, oneAs);
          if (!u) continue;
          const extra = caseBits(piece) + u.subs;
          let r = RANK.get(u.text);
          if (r) offer(i, j, log2(r) + 1 + extra, "common");
          r = RANK.get(u.text.split("").reverse().join(""));
          if (r) offer(i, j, log2(r) + 2 + extra, "common");
        }
      }
      // a whole word-like run
      const we = wordEnds.get(i);
      if (we !== undefined) {
        const piece = chars.slice(i, we);
        for (const oneAs of ["i", "l"]) {
          const u = lettersFromLeet(piece, oneAs);
          if (!u || u.subs > 2 || u.subs * 4 > piece.length || !wordCase(piece) || !looksLikeWord(u.text)) continue;
          offer(i, we, Math.min(13 * Math.ceil(u.text.length / 8) + caseBits(piece) + u.subs, rnd * piece.length), "word");
        }
      }
      // sequences (step +-1 within lowercase, uppercase or digits)
      if (i + 2 < n) {
        const cls = (x) => (isLower(x) ? 1 : isUpper(x) ? 2 : isDigit(x) ? 3 : 0);
        const k0 = cls(c), d = chars[i + 1].charCodeAt(0) - c.charCodeAt(0);
        if (k0 && (d === 1 || d === -1)) {
          let j = i + 1;
          while (j < n && cls(chars[j]) === k0 && chars[j].charCodeAt(0) - chars[j - 1].charCodeAt(0) === d) j++;
          for (let e = i + 3; e <= j; e++) offer(i, e, log2(k0 === 3 ? 10 : 26) + log2(e - i) + (d < 0 ? 1 : 0) + (k0 === 2 ? 1 : 0), "sequence");
        }
        // keyboard rows
        const p0 = ROW_OF.get(c.toLowerCase()), p1 = ROW_OF.get(chars[i + 1].toLowerCase());
        if (p0 && p1 && p0[0] === p1[0] && Math.abs(p1[1] - p0[1]) === 1) {
          const step = p1[1] - p0[1];
          let j = i + 2;
          while (j < n) {
            const a = ROW_OF.get(chars[j - 1].toLowerCase()), b = ROW_OF.get(chars[j].toLowerCase());
            if (a && b && a[0] === b[0] && b[1] - a[1] === step) j++; else break;
          }
          for (let e = i + 3; e <= j; e++) offer(i, e, log2(47) + log2(e - i) + (step < 0 ? 1 : 0) + caseBits(chars.slice(i, e)), "keyboard");
        }
      }
      // years
      if (i + 4 <= n && isDigit(c)) {
        const y = Number(chars.slice(i, i + 4).join(""));
        if (chars.slice(i, i + 4).every(isDigit) && y >= 1900 && y <= 2039) offer(i, i + 4, log2(140), "year");
      }
      // repeated blocks: block of length B repeated k >= 2 times
      for (let B = 1; B <= 32 && i + 2 * B <= n; B++) {
        let k = 1;
        while (i + (k + 1) * B <= n) {
          let same = true;
          for (let t = 0; t < B; t++) if (chars[i + k * B + t] !== chars[i + t]) { same = false; break; }
          if (!same) break;
          k++;
        }
        if (k < 2) continue;
        const blockBits = analyse(chars.slice(i, i + B), pool, false).bits;
        for (let kk = 2; kk <= k; kk++) offer(i, i + kk * B, blockBits + log2(kk), "repeat");
      }
    }
    const parts = [];
    for (let j = n; j > 0; j = from[j]) parts.push({ kind: how[j].kind, start: from[j], end: j, bits: how[j].bits });
    parts.reverse();
    const out = { bits: best[n], parts };
    if (key !== null) { if (memo.size > 5000) memo.clear(); memo.set(key, out); }
    return out;
  }

  const LABELS = [[40, "weak"], [60, "fair"], [80, "good"], [Infinity, "strong"]];
  /* -> {bits, label, warnings: string[], parts: [{kind, start, end, bits}]} (start/end are code-point indexes) */
  function estimate(p) {
    if (!p) return { bits: 0, label: "none", warnings: [], parts: [] };
    const all = Array.from(String(p));
    const chars = all.slice(0, MAX_LEN);
    const pool = poolOf(all);
    const a = analyse(chars, pool, true);
    const bits = Math.round(a.bits + (all.length - chars.length) * log2(pool));
    const label = LABELS.find(([t]) => bits < t)[1];
    const kinds = new Set(a.parts.map((x) => x.kind));
    const warnings = [];
    if (kinds.has("common")) warnings.push("Contains a common password or a word from common passwords.");
    if (kinds.has("sequence") || kinds.has("keyboard")) warnings.push("Contains a sequence or keyboard run (like abc, 123 or qwerty).");
    if (kinds.has("repeat")) warnings.push("Contains a repeated pattern.");
    if (kinds.has("year")) warnings.push("Contains a year.");
    if (bits < 60 && all.length < 12) warnings.push("Short: use 5 or more random words, or 16 or more random characters.");
    return { bits, label, warnings, parts: a.parts };
  }

  root.DexQR = root.DexQR || {};
  root.DexQR.strength = { estimate, COMMON_COUNT: RANK.size };
})(typeof globalThis !== "undefined" ? globalThis : this);
