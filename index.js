import { extension_settings, getContext } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    eventSource,
    event_types,
} from '../../../../script.js';

const MODULE_NAME = 'multi_char_single_reply';
const PROMPT_KEY = 'multi_char_single_reply';

/** Definições globais (iguais para todos os chats). */
const DEFAULTS = {
    enabled: false,
    includeGroup: true,
    includeDescriptions: true,
    maxDescChars: 600,
    format: 'label',
    depth: 1,
    customInstruction: '',
    questionCount: 5,
};

/** Dados guardados POR CHAT (em chat_metadata). */
const CHAT_DEFAULTS = {
    extras: [],        // avatares dos personagens extra
    context: '',       // contexto escrito pelo utilizador
    questions: [],     // [{ q, a }]
    scenePrompt: '',   // prompt de cena gerado (editável)
    useScene: true,
};

const FORMAT_RULES = {
    label: 'Start each character\'s part with their name in bold followed by a colon, for example: **Name:** "speech" *action*.',
    narrative: 'Write in flowing narrative prose without name labels, making it clear who speaks or acts in each passage.',
    script: 'Use script format: NAME: line (stage directions in parentheses).',
    custom: '',
};

let busy = false;
let orphanData = null; // usado se não houver chat aberto

/* ------------------------------------------------------------------ */
/* Definições e dados por chat                                         */
/* ------------------------------------------------------------------ */

function fillDefaults(target, defaults) {
    for (const [key, value] of Object.entries(defaults)) {
        if (target[key] === undefined) {
            target[key] = Array.isArray(value) ? [...value] : value;
        }
    }
    return target;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    return fillDefaults(extension_settings[MODULE_NAME], DEFAULTS);
}

function chatData() {
    const meta = getContext().chatMetadata;
    if (!meta) {
        if (!orphanData) orphanData = fillDefaults({}, CHAT_DEFAULTS);
        return orphanData;
    }
    if (!meta[MODULE_NAME]) meta[MODULE_NAME] = {};
    return fillDefaults(meta[MODULE_NAME], CHAT_DEFAULTS);
}

function saveChatData() {
    const ctx = getContext();
    const fn = ctx.saveMetadataDebounced || ctx.saveMetadata;
    if (typeof fn === 'function') fn();
}

/* ------------------------------------------------------------------ */
/* Elenco e construção de prompts                                      */
/* ------------------------------------------------------------------ */

function collectCast() {
    const ctx = getContext();
    const s = getSettings();
    const d = chatData();
    const characters = ctx.characters || [];
    const cast = [];
    const seen = new Set();

    const add = (ch) => {
        if (!ch || !ch.name || seen.has(ch.avatar)) return;
        seen.add(ch.avatar);
        cast.push(ch);
    };

    if (ctx.groupId) {
        if (s.includeGroup) {
            const group = (ctx.groups || []).find(g => String(g.id) === String(ctx.groupId));
            const disabled = group?.disabled_members || [];
            (group?.members || []).forEach(avatar => {
                if (!disabled.includes(avatar)) {
                    add(characters.find(c => c.avatar === avatar));
                }
            });
        }
    } else if (ctx.characterId !== undefined && ctx.characterId !== null) {
        add(characters[ctx.characterId]);
    }

    d.extras.forEach(avatar => add(characters.find(c => c.avatar === avatar)));
    return cast;
}

function describeCast(cast, maxChars) {
    return cast.map(ch => {
        const raw = [ch.description, ch.personality].filter(Boolean).join('\n');
        const clean = raw.replace(/\{\{char\}\}/gi, ch.name).trim();
        const short = clean.length > maxChars ? clean.slice(0, maxChars) + '…' : clean;
        return `### ${ch.name}\n${short}`;
    }).join('\n\n');
}

/** Prompt final injetado em cada geração. */
function buildPrompt() {
    const s = getSettings();
    const d = chatData();
    const cast = collectCast();
    if (!s.enabled || cast.length < 2) return '';

    const names = cast.map(c => c.name).join(', ');
    const formatRule = s.format === 'custom' ? s.customInstruction : FORMAT_RULES[s.format];

    let text = `[Multi-character scene. Write ONE single reply that contains the contributions of ALL of these characters: ${names}. `
        + 'Every reply must include the lines, actions and reactions of each character present in the scene, all in the same message. '
        + 'Do not save a character\'s turn for later. Never write dialogue, thoughts or actions for {{user}}.';

    if (formatRule) {
        text += `\n${formatRule}`;
    }

    if (d.useScene && d.scenePrompt.trim()) {
        text += `\n\nScene setup:\n${d.scenePrompt.trim()}`;
    }

    if (s.includeDescriptions) {
        text += `\n\nCharacter details:\n${describeCast(cast, s.maxDescChars)}`;
    }

    text += ']';
    return text;
}

function updatePrompt() {
    const s = getSettings();
    try {
        setExtensionPrompt(PROMPT_KEY, buildPrompt(), extension_prompt_types.IN_CHAT, Number(s.depth) || 1);
    } catch (err) {
        console.error('[MCSR] Erro a definir o prompt', err);
    }
}

/* ------------------------------------------------------------------ */
/* Geração (perguntas e cena)                                          */
/* ------------------------------------------------------------------ */

async function rawGenerate(systemPrompt, prompt, responseLength) {
    const ctx = getContext();
    if (typeof ctx.generateRaw !== 'function') {
        throw new Error('generateRaw não está disponível nesta versão do SillyTavern.');
    }

    let out;
    try {
        // Assinatura posicional (versões mais comuns)
        out = await ctx.generateRaw(prompt, null, false, false, systemPrompt, responseLength);
    } catch (err) {
        // Assinatura por objeto (versões mais novas)
        out = await ctx.generateRaw({ prompt, systemPrompt, responseLength });
    }

    const text = String(out ?? '').trim();
    if (!text) throw new Error('O modelo devolveu uma resposta vazia. Verifica a ligação à API.');
    return text;
}

function parseQuestions(text) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
        try {
            const arr = JSON.parse(match[0]);
            if (Array.isArray(arr)) {
                const list = arr
                    .map(x => (typeof x === 'string' ? x : (x?.question || x?.q || '')))
                    .map(x => String(x).trim())
                    .filter(Boolean);
                if (list.length) return list;
            }
        } catch { /* cai para o fallback */ }
    }
    return text
        .split('\n')
        .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["']|["',]+$/g, '').trim())
        .filter(l => l.length > 8 && l.includes('?'));
}

function cleanOutput(text) {
    return text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
}

async function generateQuestions() {
    const s = getSettings();
    const d = chatData();
    const ctx = getContext();
    const cast = collectCast();

    if (cast.length < 2) {
        toastr.warning('Escolhe pelo menos 2 personagens (o atual já conta como um).');
        return;
    }
    if (!d.context.trim()) {
        toastr.warning('Escreve primeiro o contexto da cena.');
        return;
    }

    const n = Math.min(10, Math.max(2, Number(s.questionCount) || 5));
    const system = 'You are a collaborative storytelling assistant helping to set up a multi-character roleplay scene. '
        + 'You will receive character cards and the user\'s scene context. '
        + `Ask the user exactly ${n} short, concrete and pertinent questions whose answers would most improve the scene setup `
        + '(relationships between the characters, secrets or hidden knowledge, goals, tone and pacing, who leads the scene, starting situation, limits). '
        + 'Do not ask about things already clear from the cards or the context. '
        + 'Write the questions in the same language as the user\'s scene context. '
        + 'Output ONLY a JSON array of strings, with no commentary and no code fences.';

    const prompt = `User persona: ${ctx.name1 || 'User'}\n\nCharacters:\n${describeCast(cast, 1200)}\n\nScene context from the user:\n${d.context.trim()}`;

    const out = await rawGenerate(system, prompt, 500);
    const questions = parseQuestions(out).slice(0, n);
    if (!questions.length) {
        throw new Error('Não consegui interpretar as perguntas. Tenta outra vez.');
    }

    d.questions = questions.map(q => ({ q, a: '' }));
    saveChatData();
    renderQuestions();
    toastr.success('Perguntas geradas. Responde e depois constrói a cena.');
}

async function buildScene() {
    const d = chatData();
    const ctx = getContext();
    const cast = collectCast();

    if (cast.length < 2) {
        toastr.warning('Escolhe pelo menos 2 personagens.');
        return;
    }
    if (!d.questions.length) {
        toastr.warning('Gera primeiro as perguntas.');
        return;
    }

    const qa = d.questions
        .map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a?.trim() || '(no answer, use your judgment)'}`)
        .join('\n\n');

    const system = 'You are a roleplay scene designer. Using the character cards, the user\'s context and their answers, '
        + 'write a SCENE SETUP that will be injected into the roleplay prompt so that a single reply can voice every character. '
        + 'Use short headings: "Setting & starting situation", "Relationships & dynamics" (cover the relevant pairs), '
        + '"Goals, mood and knowledge" (per character), "Tone & style". '
        + 'Rules: do NOT rewrite or summarize the character cards (they are supplied separately), only add what is new from the context and answers; '
        + 'do not contradict the user; do not invent major facts; keep it under about 400 words; '
        + 'refer to the user\'s character as {{user}}; write in the same language as the user\'s scene context. '
        + 'Output ONLY the scene setup text.';

    const prompt = `User persona: ${ctx.name1 || 'User'}\n\nCharacters:\n${describeCast(cast, 1500)}\n\n`
        + `Scene context from the user:\n${d.context.trim()}\n\nQuestions and answers:\n${qa}`;

    const out = cleanOutput(await rawGenerate(system, prompt, 900));

    d.scenePrompt = out;
    d.useScene = true;
    saveChatData();
    $('#mcsr_scene').val(d.scenePrompt);
    $('#mcsr_use_scene').prop('checked', true);
    updatePrompt();
    toastr.success('Cena construída. Podes editar o texto antes de jogar.');
}

async function withBusy(selector, label, fn) {
    if (busy) {
        toastr.info('Já há uma operação em curso.');
        return;
    }
    busy = true;
    const $btn = $(selector);
    const original = $btn.text();
    $btn.addClass('disabled').text(label);
    try {
        await fn();
    } catch (err) {
        console.error('[MCSR]', err);
        toastr.error(String(err?.message || err), 'Multi-Character Single Reply');
    } finally {
        busy = false;
        $btn.removeClass('disabled').text(original);
    }
}

/* ------------------------------------------------------------------ */
/* Interface                                                           */
/* ------------------------------------------------------------------ */

function renderCharacterList() {
    const d = chatData();
    const ctx = getContext();
    const filter = String($('#mcsr_filter').val() || '').toLowerCase();
    const $list = $('#mcsr_list').empty();
    const current = ctx.groupId ? null : ctx.characters?.[ctx.characterId]?.avatar;

    (ctx.characters || []).forEach(ch => {
        if (!ch?.name || ch.avatar === current) return;
        if (filter && !ch.name.toLowerCase().includes(filter)) return;

        const $cb = $('<input type="checkbox">')
            .prop('checked', d.extras.includes(ch.avatar))
            .on('change', function () {
                const checked = $(this).prop('checked');
                d.extras = d.extras.filter(a => a !== ch.avatar);
                if (checked) d.extras.push(ch.avatar);
                saveChatData();
                updatePrompt();
            });

        const $row = $('<label class="mcsr-row checkbox_label"></label>');
        $row.append($cb, $('<span></span>').text(ch.name));
        $list.append($row);
    });

    if (!$list.children().length) {
        $list.append($('<div class="mcsr-empty"></div>').text('Nenhum personagem encontrado.'));
    }
}

function renderQuestions() {
    const d = chatData();
    const $box = $('#mcsr_questions').empty();

    d.questions.forEach((item, i) => {
        const $label = $('<label class="mcsr-qlabel"></label>').text(`${i + 1}. ${item.q}`);
        const $ta = $('<textarea class="text_pole" rows="2"></textarea>')
            .val(item.a || '')
            .on('input', function () {
                item.a = $(this).val();
                saveChatData();
            });
        $box.append($('<div class="mcsr-q"></div>').append($label, $ta));
    });

    $('#mcsr_build_wrap').toggle(d.questions.length > 0);
}

function refreshChatUI() {
    const d = chatData();
    $('#mcsr_context').val(d.context);
    $('#mcsr_scene').val(d.scenePrompt);
    $('#mcsr_use_scene').prop('checked', !!d.useScene);
    renderCharacterList();
    renderQuestions();
}

function bindSetting(selector, key, type = 'text') {
    const s = getSettings();
    const $el = $(selector);
    if (type === 'checkbox') {
        $el.prop('checked', !!s[key]);
    } else {
        $el.val(s[key]);
    }
    $el.on('input change', function () {
        s[key] = type === 'checkbox' ? $(this).prop('checked')
            : type === 'number' ? Number($(this).val())
                : $(this).val();
        if (key === 'format') {
            $('#mcsr_custom_wrap').toggle(s.format === 'custom');
        }
        saveSettingsDebounced();
        updatePrompt();
    });
}

function bindChatField(selector, key, type = 'text') {
    $(selector).on('input change', function () {
        const d = chatData();
        d[key] = type === 'checkbox' ? $(this).prop('checked') : $(this).val();
        saveChatData();
        updatePrompt();
    });
}

function renderUI() {
    const html = `
    <div class="mcsr-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Multi-Character Single Reply</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <label class="checkbox_label">
                    <input type="checkbox" id="mcsr_enabled">
                    <span>Ativar (várias personagens numa só resposta)</span>
                </label>

                <hr>
                <b>1. Personagens na cena</b>
                <small>O personagem atual (ou os membros do grupo) é incluído automaticamente.</small>
                <input type="text" id="mcsr_filter" class="text_pole" placeholder="Filtrar por nome...">
                <div id="mcsr_list" class="mcsr-list"></div>
                <div class="menu_button" id="mcsr_refresh">Atualizar lista</div>

                <hr>
                <b>2. Contexto da cena</b>
                <small>Descreve onde estão, o que se passa, as relações que já conheces...</small>
                <textarea id="mcsr_context" class="text_pole" rows="4"
                    placeholder="Ex.: Estão todos presos numa taverna durante uma tempestade. A e B têm um passado juntos..."></textarea>
                <div class="menu_button" id="mcsr_gen_q">Gerar perguntas</div>

                <div id="mcsr_questions" class="mcsr-questions"></div>

                <div id="mcsr_build_wrap">
                    <div class="menu_button" id="mcsr_build">Construir cena</div>
                </div>

                <hr>
                <b>3. Prompt da cena (editável)</b>
                <textarea id="mcsr_scene" class="text_pole" rows="10"
                    placeholder="Aparece aqui depois de construíres a cena. Também podes escrever à mão."></textarea>
                <label class="checkbox_label">
                    <input type="checkbox" id="mcsr_use_scene">
                    <span>Usar este prompt de cena</span>
                </label>
                <div class="mcsr-buttons">
                    <div class="menu_button" id="mcsr_clear">Limpar cena</div>
                    <div class="menu_button" id="mcsr_preview_btn">Ver prompt injetado</div>
                </div>
                <textarea id="mcsr_preview" class="text_pole" rows="8" readonly></textarea>

                <hr>
                <details>
                    <summary><b>Definições avançadas</b></summary>
                    <div class="mcsr-advanced">
                        <label class="checkbox_label">
                            <input type="checkbox" id="mcsr_include_group">
                            <span>Incluir membros do grupo (chats de grupo)</span>
                        </label>
                        <label class="checkbox_label">
                            <input type="checkbox" id="mcsr_include_desc">
                            <span>Incluir descrições dos personagens no prompt</span>
                        </label>

                        <label for="mcsr_max_desc">Máx. caracteres por descrição</label>
                        <input type="number" id="mcsr_max_desc" class="text_pole" min="100" max="5000" step="50">

                        <label for="mcsr_qcount">Número de perguntas</label>
                        <input type="number" id="mcsr_qcount" class="text_pole" min="2" max="10" step="1">

                        <label for="mcsr_format">Formato da resposta</label>
                        <select id="mcsr_format" class="text_pole">
                            <option value="label">**Nome:** fala</option>
                            <option value="narrative">Prosa narrativa (sem etiquetas)</option>
                            <option value="script">Guião (NOME: fala)</option>
                            <option value="custom">Personalizado</option>
                        </select>

                        <div id="mcsr_custom_wrap">
                            <label for="mcsr_custom">Instrução de formato personalizada</label>
                            <textarea id="mcsr_custom" class="text_pole" rows="3"></textarea>
                        </div>

                        <label for="mcsr_depth">Profundidade de injeção (1 = perto da última mensagem)</label>
                        <input type="number" id="mcsr_depth" class="text_pole" min="0" max="20" step="1">
                    </div>
                </details>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    bindSetting('#mcsr_enabled', 'enabled', 'checkbox');
    bindSetting('#mcsr_include_group', 'includeGroup', 'checkbox');
    bindSetting('#mcsr_include_desc', 'includeDescriptions', 'checkbox');
    bindSetting('#mcsr_max_desc', 'maxDescChars', 'number');
    bindSetting('#mcsr_qcount', 'questionCount', 'number');
    bindSetting('#mcsr_format', 'format');
    bindSetting('#mcsr_custom', 'customInstruction');
    bindSetting('#mcsr_depth', 'depth', 'number');
    $('#mcsr_custom_wrap').toggle(getSettings().format === 'custom');

    bindChatField('#mcsr_context', 'context');
    bindChatField('#mcsr_scene', 'scenePrompt');
    bindChatField('#mcsr_use_scene', 'useScene', 'checkbox');

    $('#mcsr_filter').on('input', renderCharacterList);
    $('#mcsr_refresh').on('click', renderCharacterList);

    $('#mcsr_gen_q').on('click', () => withBusy('#mcsr_gen_q', 'A gerar perguntas...', generateQuestions));
    $('#mcsr_build').on('click', () => withBusy('#mcsr_build', 'A construir cena...', buildScene));

    $('#mcsr_clear').on('click', () => {
        if (!window.confirm('Limpar perguntas e prompt de cena deste chat?')) return;
        const d = chatData();
        d.questions = [];
        d.scenePrompt = '';
        saveChatData();
        refreshChatUI();
        updatePrompt();
    });

    $('#mcsr_preview_btn').on('click', () => {
        $('#mcsr_preview').val(buildPrompt() || '(vazio: ativa a extensão e garante pelo menos 2 personagens na cena)');
    });

    refreshChatUI();
}

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

jQuery(() => {
    getSettings();
    renderUI();
    updatePrompt();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        orphanData = null;
        refreshChatUI();
        updatePrompt();
    });

    [event_types.GENERATION_STARTED, event_types.GROUP_UPDATED, event_types.CHARACTER_EDITED]
        .filter(Boolean)
        .forEach(evt => eventSource.on(evt, updatePrompt));

    console.log('[MCSR] Multi-Character Single Reply v2 carregado');
});
