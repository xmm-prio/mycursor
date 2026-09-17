/*
 * Panel client.
 *
 * Plain DOM rather than a framework: the panel ships inside a VSIX that has to
 * stay small and load instantly in a sidebar, and a bundled UI library would
 * be larger than everything else in the extension combined.
 *
 * The editing model is deliberate. Edits mutate an in-memory draft and mark
 * the panel dirty; nothing reaches disk until Save. That keeps a half-typed
 * API key or context limit from being written out and picked up by the running
 * server mid-keystroke.
 */

/* global acquireVsCodeApi */
(() => {
  const vscode = acquireVsCodeApi();

  /** @type {{providers: any[], webSearch: any, options: any, dirty: boolean, catalogs: Record<string, any[]>, collapsed: Set<string>}} */
  const state = {
    providers: [],
    webSearch: { enabled: false, backend: 'duckduckgo', apiKey: '', maxResults: 5, allowFetch: true, proxyUrl: '' },
    options: { types: [], thinkingLevels: [], defaultBaseUrls: {}, searchBackends: [] },
    dirty: false,
    catalogs: {},
    collapsed: new Set(),
  };

  const $ = (id) => document.getElementById(id);
  const providersEl = $('providers');
  const emptyEl = $('empty');
  const noticeEl = $('notice');
  const busyEl = $('busy');
  const footerEl = document.querySelector('.footer');

  // ------------------------------------------------------------- helpers --

  function markDirty() {
    state.dirty = true;
    footerEl.classList.add('dirty');
  }

  function clearDirty() {
    state.dirty = false;
    footerEl.classList.remove('dirty');
  }

  function notice(text, level = 'info') {
    if (!text) {
      noticeEl.hidden = true;
      return;
    }
    noticeEl.textContent = text;
    noticeEl.dataset.level = level;
    noticeEl.hidden = false;
    clearTimeout(notice.timer);
    notice.timer = setTimeout(() => {
      noticeEl.hidden = true;
    }, 4000);
  }

  function setBusy(busy, label) {
    busyEl.hidden = !busy;
    $('busy-label').textContent = label ?? '';
  }

  function slug(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Ranks catalog entries against what the user typed.
   *
   * Subsequence matching rather than substring: model names are long and
   * dotted, so "g41" should still find "gpt-4.1". Earlier and tighter matches
   * rank higher.
   */
  function fuzzyRank(query, candidates) {
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates.slice(0, 40);

    const scored = [];
    for (const entry of candidates) {
      const haystack = entry.id.toLowerCase();
      let index = 0;
      let score = 0;
      let firstHit = -1;
      let previousHit = -1;

      for (const char of needle) {
        const found = haystack.indexOf(char, index);
        if (found === -1) {
          index = -1;
          break;
        }
        if (firstHit === -1) firstHit = found;
        // Consecutive characters are a much stronger signal than scattered ones.
        score += previousHit === found - 1 ? 3 : 1;
        previousHit = found;
        index = found + 1;
      }
      if (index === -1) continue;

      score += Math.max(0, 12 - firstHit);
      if (haystack === needle) score += 60;
      else if (haystack.startsWith(needle)) score += 25;
      scored.push({ entry, score });
    }

    return scored
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, 40)
      .map((item) => item.entry);
  }

  function parseHeaders(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: true, value: undefined };
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, value: undefined };
      }
      const result = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') result[key] = value;
      }
      return { ok: true, value: result };
    } catch {
      return { ok: false, value: undefined };
    }
  }

  // -------------------------------------------------------------- render --

  function render() {
    providersEl.replaceChildren();
    emptyEl.hidden = state.providers.length > 0;

    for (const provider of state.providers) {
      providersEl.appendChild(renderProvider(provider));
    }
  }

  function renderProvider(provider) {
    const node = $('provider-template').content.firstElementChild.cloneNode(true);
    const open = !state.collapsed.has(provider.id);
    node.classList.toggle('open', open);
    node.dataset.providerId = provider.id;

    const nameInput = node.querySelector('[data-field="name"]');
    nameInput.value = provider.name;
    nameInput.addEventListener('input', () => {
      provider.name = nameInput.value;
      markDirty();
    });

    const enabled = node.querySelector('[data-field="enabled"]');
    enabled.checked = provider.enabled !== false;
    enabled.addEventListener('change', () => {
      provider.enabled = enabled.checked;
      markDirty();
    });

    const typeSelect = node.querySelector('[data-field="type"]');
    for (const option of state.options.types) {
      const element = document.createElement('option');
      element.value = option.type;
      element.textContent = option.label;
      typeSelect.appendChild(element);
    }
    typeSelect.value = provider.type;
    const baseUrlInput = node.querySelector('[data-field="baseUrl"]');
    const applyPlaceholder = () => {
      baseUrlInput.placeholder = state.options.defaultBaseUrls[provider.type] ?? '';
    };
    typeSelect.addEventListener('change', () => {
      provider.type = typeSelect.value;
      applyPlaceholder();
      markDirty();
    });

    baseUrlInput.value = provider.baseUrl ?? '';
    applyPlaceholder();
    baseUrlInput.addEventListener('input', () => {
      provider.baseUrl = baseUrlInput.value;
      markDirty();
    });

    const auth = node.querySelector('[data-field="authValue"]');
    auth.value = provider.authValue ?? '';
    auth.addEventListener('input', () => {
      provider.authValue = auth.value;
      markDirty();
    });
    node.querySelector('[data-role="reveal"]').addEventListener('click', () => {
      auth.type = auth.type === 'password' ? 'text' : 'password';
    });

    const proxy = node.querySelector('[data-field="proxyUrl"]');
    proxy.value = provider.proxyUrl ?? '';
    proxy.addEventListener('input', () => {
      provider.proxyUrl = proxy.value;
      markDirty();
    });

    const headers = node.querySelector('[data-field="headers"]');
    headers.value = provider.headers ? JSON.stringify(provider.headers, null, 2) : '';
    headers.addEventListener('input', () => {
      const parsed = parseHeaders(headers.value);
      headers.classList.toggle('invalid', !parsed.ok);
      if (parsed.ok) provider.headers = parsed.value;
      markDirty();
    });

    node.querySelector('[data-role="collapse"]').addEventListener('click', () => {
      const nowOpen = !node.classList.contains('open');
      node.classList.toggle('open', nowOpen);
      if (nowOpen) state.collapsed.delete(provider.id);
      else state.collapsed.add(provider.id);
    });

    node.querySelector('[data-role="delete-provider"]').addEventListener('click', () => {
      state.providers = state.providers.filter((entry) => entry !== provider);
      markDirty();
      render();
    });

    node.querySelector('[data-role="fetch"]').addEventListener('click', () => {
      vscode.postMessage({ type: 'fetchModels', provider });
    });

    const modelsEl = node.querySelector('[data-role="models"]');
    const countEl = node.querySelector('[data-role="model-count"]');
    const paintModels = () => {
      modelsEl.replaceChildren();
      for (const model of provider.models) {
        modelsEl.appendChild(renderModel(provider, model, paintModels));
      }
      countEl.textContent = String(provider.models.length);
    };
    paintModels();

    node.querySelector('[data-role="add-model"]').addEventListener('click', () => {
      provider.models.push(blankModel());
      markDirty();
      paintModels();
    });

    return node;
  }

  function blankModel() {
    return {
      id: '',
      apiModel: '',
      displayName: '',
      enabled: true,
      capabilities: {
        agent: true,
        images: false,
        cmdK: true,
        fast: false,
        thinking: false,
        thinkingLevel: 'medium',
      },
      contextTokenLimit: 128000,
      maxOutputTokens: 8192,
      quickSwitch: { reasoningLevels: [], contextOptions: [], fastToggle: false },
    };
  }

  function renderModel(provider, model, repaint) {
    const node = $('model-template').content.firstElementChild.cloneNode(true);
    const key = `${provider.id}:${model.id || model.apiModel}`;
    node.classList.toggle('open', !state.collapsed.has(key));
    node.classList.toggle('disabled', model.enabled === false);

    const title = node.querySelector('[data-role="model-title"]');
    const refreshTitle = () => {
      title.textContent = model.displayName || model.apiModel || 'New model';
    };
    refreshTitle();

    node.querySelector('[data-role="collapse-model"]').addEventListener('click', () => {
      const nowOpen = !node.classList.contains('open');
      node.classList.toggle('open', nowOpen);
      if (nowOpen) state.collapsed.delete(key);
      else state.collapsed.add(key);
    });

    const enabled = node.querySelector('[data-field="enabled"]');
    enabled.checked = model.enabled !== false;
    enabled.addEventListener('change', () => {
      model.enabled = enabled.checked;
      node.classList.toggle('disabled', !enabled.checked);
      markDirty();
    });

    node.querySelector('[data-role="remove-model"]').addEventListener('click', () => {
      provider.models = provider.models.filter((entry) => entry !== model);
      markDirty();
      repaint();
    });

    // --- API model, with fuzzy search over whatever Fetch returned --------
    const apiInput = node.querySelector('[data-field="apiModel"]');
    const suggestions = node.querySelector('[data-role="suggestions"]');
    apiInput.value = model.apiModel ?? '';

    const closeSuggestions = () => {
      suggestions.hidden = true;
      suggestions.replaceChildren();
    };

    const openSuggestions = () => {
      const catalog = state.catalogs[provider.id] ?? [];
      if (catalog.length === 0) {
        suggestions.replaceChildren(
          Object.assign(document.createElement('div'), {
            className: 'combo-empty',
            textContent: 'No catalog yet — press ↓ Fetch to load models.',
          }),
        );
        suggestions.hidden = false;
        return;
      }

      const matches = fuzzyRank(apiInput.value, catalog);
      suggestions.replaceChildren();
      if (matches.length === 0) {
        suggestions.appendChild(
          Object.assign(document.createElement('div'), {
            className: 'combo-empty',
            textContent: 'No match',
          }),
        );
      }
      for (const entry of matches) {
        const item = document.createElement('div');
        item.className = 'combo-item';
        const name = document.createElement('span');
        name.textContent = entry.id;
        item.appendChild(name);
        if (entry.contextWindow) {
          const hint = document.createElement('span');
          hint.className = 'hint';
          hint.textContent = `${Math.round(entry.contextWindow / 1000)}k`;
          item.appendChild(hint);
        }
        // `mousedown` fires before the input's blur, so the click is not lost.
        item.addEventListener('mousedown', (event) => {
          event.preventDefault();
          model.apiModel = entry.id;
          if (!model.id) model.id = slug(entry.id);
          if (!model.displayName) model.displayName = entry.displayName ?? entry.id;
          if (entry.contextWindow) model.contextTokenLimit = entry.contextWindow;
          if (entry.maxOutputTokens) model.maxOutputTokens = entry.maxOutputTokens;
          markDirty();
          closeSuggestions();
          repaint();
        });
        suggestions.appendChild(item);
      }
      suggestions.hidden = false;
    };

    apiInput.addEventListener('focus', openSuggestions);
    apiInput.addEventListener('input', () => {
      model.apiModel = apiInput.value;
      if (!model.id) model.id = slug(apiInput.value);
      refreshTitle();
      markDirty();
      openSuggestions();
    });
    apiInput.addEventListener('blur', () => setTimeout(closeSuggestions, 120));

    const display = node.querySelector('[data-field="displayName"]');
    display.value = model.displayName ?? '';
    display.addEventListener('input', () => {
      model.displayName = display.value;
      refreshTitle();
      markDirty();
    });

    // --- capabilities -----------------------------------------------------
    for (const box of node.querySelectorAll('[data-cap]')) {
      const capability = box.dataset.cap;
      box.checked = Boolean(model.capabilities?.[capability]);
      box.addEventListener('change', () => {
        model.capabilities[capability] = box.checked;
        markDirty();
      });
    }

    const thinkingLevel = node.querySelector('[data-field="thinkingLevel"]');
    for (const level of state.options.thinkingLevels) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level;
      thinkingLevel.appendChild(option);
    }
    thinkingLevel.value = model.capabilities?.thinkingLevel ?? 'medium';
    thinkingLevel.addEventListener('change', () => {
      model.capabilities.thinkingLevel = thinkingLevel.value;
      markDirty();
    });

    // --- limits -----------------------------------------------------------
    const context = node.querySelector('[data-field="contextTokenLimit"]');
    context.value = model.contextTokenLimit ?? '';
    context.addEventListener('input', () => {
      const value = Number.parseInt(context.value, 10);
      context.classList.toggle('invalid', !Number.isFinite(value) || value <= 0);
      if (Number.isFinite(value) && value > 0) model.contextTokenLimit = value;
      markDirty();
    });

    const output = node.querySelector('[data-field="maxOutputTokens"]');
    output.value = model.maxOutputTokens ?? '';
    output.addEventListener('input', () => {
      const value = Number.parseInt(output.value, 10);
      output.classList.toggle('invalid', !Number.isFinite(value) || value <= 0);
      if (Number.isFinite(value) && value > 0) model.maxOutputTokens = value;
      markDirty();
    });

    const tooltip = node.querySelector('[data-field="tooltipMarkdown"]');
    tooltip.value = model.tooltipMarkdown ?? '';
    tooltip.addEventListener('input', () => {
      model.tooltipMarkdown = tooltip.value;
      markDirty();
    });

    // --- quick switch -----------------------------------------------------
    const pills = node.querySelector('[data-role="reasoning-levels"]');
    model.quickSwitch = model.quickSwitch ?? {
      reasoningLevels: [],
      contextOptions: [],
      fastToggle: false,
    };
    for (const level of state.options.thinkingLevels) {
      const pill = document.createElement('label');
      pill.className = 'cap';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = model.quickSwitch.reasoningLevels.includes(level);
      box.addEventListener('change', () => {
        const set = new Set(model.quickSwitch.reasoningLevels);
        if (box.checked) set.add(level);
        else set.delete(level);
        // Keep the configured order stable so the picker does not reshuffle.
        model.quickSwitch.reasoningLevels = state.options.thinkingLevels.filter((entry) =>
          set.has(entry),
        );
        markDirty();
      });
      const text = document.createElement('span');
      text.textContent = level;
      pill.append(box, text);
      pills.appendChild(pill);
    }

    const contextOptions = node.querySelector('[data-field="contextOptions"]');
    contextOptions.value = (model.quickSwitch.contextOptions ?? []).join(', ');
    contextOptions.addEventListener('input', () => {
      model.quickSwitch.contextOptions = contextOptions.value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      markDirty();
    });

    const fastToggle = node.querySelector('[data-field="fastToggle"]');
    fastToggle.checked = Boolean(model.quickSwitch.fastToggle);
    fastToggle.addEventListener('change', () => {
      model.quickSwitch.fastToggle = fastToggle.checked;
      markDirty();
    });

    return node;
  }

  // --------------------------------------------------------- web search --

  /**
   * Paints the web search card.
   *
   * The key field is hidden for backends that need no account, because an
   * empty required-looking box is the kind of thing that makes a working
   * default look unfinished.
   */
  function renderWebSearch() {
    const search = state.webSearch;
    const card = $('websearch');
    const backendSelect = $('ws-backend');

    if (backendSelect.options.length === 0) {
      for (const backend of state.options.searchBackends ?? []) {
        const option = document.createElement('option');
        option.value = backend.id;
        option.textContent = backend.requiresApiKey ? `${backend.label} (key)` : backend.label;
        backendSelect.appendChild(option);
      }
    }
    backendSelect.value = search.backend;

    const chosen = (state.options.searchBackends ?? []).find((entry) => entry.id === search.backend);
    $('ws-key-field').hidden = !chosen?.requiresApiKey;

    card.classList.toggle('open', search.enabled);
    $('ws-enabled').checked = Boolean(search.enabled);
    $('ws-api-key').value = search.apiKey ?? '';
    $('ws-max-results').value = search.maxResults ?? 5;
    $('ws-proxy').value = search.proxyUrl ?? '';
    $('ws-allow-fetch').checked = search.allowFetch !== false;

    $('ws-summary').textContent = search.enabled ? (chosen?.label ?? search.backend) : 'off';
  }

  $('ws-enabled').addEventListener('change', () => {
    state.webSearch.enabled = $('ws-enabled').checked;
    markDirty();
    renderWebSearch();
  });
  $('ws-collapse').addEventListener('click', () => {
    $('websearch').classList.toggle('open');
  });
  $('ws-backend').addEventListener('change', () => {
    state.webSearch.backend = $('ws-backend').value;
    markDirty();
    renderWebSearch();
  });
  $('ws-api-key').addEventListener('input', () => {
    state.webSearch.apiKey = $('ws-api-key').value;
    markDirty();
  });
  $('ws-reveal').addEventListener('click', () => {
    const field = $('ws-api-key');
    field.type = field.type === 'password' ? 'text' : 'password';
  });
  $('ws-max-results').addEventListener('input', () => {
    const value = Number.parseInt($('ws-max-results').value, 10);
    const valid = Number.isFinite(value) && value >= 1 && value <= 20;
    $('ws-max-results').classList.toggle('invalid', !valid);
    if (valid) state.webSearch.maxResults = value;
    markDirty();
  });
  $('ws-proxy').addEventListener('input', () => {
    state.webSearch.proxyUrl = $('ws-proxy').value;
    markDirty();
  });
  $('ws-allow-fetch').addEventListener('change', () => {
    state.webSearch.allowFetch = $('ws-allow-fetch').checked;
    markDirty();
  });

  // ------------------------------------------------------------- status --

  function paintStatus(payload) {
    const byokOn = Boolean(payload.byokMode);
    $('byok-dot').className = `dot ${byokOn ? 'on' : 'off'}`;
    $('byok-label').textContent = byokOn ? 'BYOK on' : 'BYOK off';

    const online = Boolean(payload.server?.online);
    $('server-dot').className = `dot ${online ? 'on' : 'off'}`;
    $('server-label').textContent = online ? `Server ${payload.server.version}` : 'Server offline';

    const schemaOk = Boolean(payload.server?.schemaAvailable);
    $('schema-dot').className = `dot ${online ? (schemaOk ? 'on' : 'warn') : ''}`;
    $('schema-label').textContent = schemaOk
      ? `Schema ${payload.server.schemaCursorVersion ?? ''}`.trim()
      : 'No schema';
    $('schema-chip').title = schemaOk
      ? 'Cursor protocol schema loaded — models can be injected into the picker'
      : 'Run "mycursor schema" so models can be injected into the picker';
  }

  // ------------------------------------------------------------ actions --

  $('add-provider').addEventListener('click', () => {
    state.providers.push({
      id: `provider-${Date.now().toString(36)}`,
      name: 'New provider',
      type: 'openai-chat',
      baseUrl: '',
      authValue: '',
      enabled: true,
      models: [],
    });
    markDirty();
    render();
  });

  $('save').addEventListener('click', () => {
    // Fill in identities the user never typed, so a model is always addressable.
    for (const provider of state.providers) {
      for (const model of provider.models) {
        if (!model.id) model.id = slug(model.apiModel);
        if (!model.displayName) model.displayName = model.apiModel;
      }
    }
    setBusy(true, 'Saving…');
    vscode.postMessage({ type: 'save', providers: state.providers, webSearch: state.webSearch });
    clearDirty();
  });

  $('reset').addEventListener('click', () => {
    setBusy(true, 'Reloading…');
    vscode.postMessage({ type: 'reload' });
    clearDirty();
  });

  $('reload').addEventListener('click', () => {
    setBusy(true, 'Reloading…');
    vscode.postMessage({ type: 'reload' });
  });

  $('open-file').addEventListener('click', () => vscode.postMessage({ type: 'openProvidersFile' }));
  $('byok-chip').addEventListener('click', () => vscode.postMessage({ type: 'toggleByok' }));
  $('server-chip').addEventListener('click', () => vscode.postMessage({ type: 'restartServer' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        state.providers = message.providers ?? [];
        state.webSearch = message.webSearch ?? state.webSearch;
        state.options = message.options ?? state.options;
        paintStatus(message);
        renderWebSearch();
        render();
        clearDirty();
        if (message.notice) notice(message.notice);
        break;

      case 'catalog':
        state.catalogs[message.providerId] = message.entries ?? [];
        break;

      case 'notice':
        notice(message.text, message.level);
        break;

      case 'busy':
        setBusy(message.busy, message.label);
        break;

      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
