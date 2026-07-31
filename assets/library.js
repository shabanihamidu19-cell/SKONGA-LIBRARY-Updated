let allSubjects = [];
let subjectCache = new Map();
let currentSubject = null;
let currentTopicData = null;

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function renderSkeletons() {
  const skeletonHtml = Array.from({ length: 8 }).map(() => '<div class="skeleton-card"></div>').join('');
  const featured = document.getElementById('featured-subjects');
  const grid = document.getElementById('all-subjects-grid');
  if (featured) featured.innerHTML = skeletonHtml;
  if (grid) grid.innerHTML = skeletonHtml;
}

async function initData() {
  renderSkeletons();
  try {
    const response = await fetch('./Subjects.json');
    if (!response.ok) throw new Error('Subjects.json not found');
    allSubjects = await response.json();
    renderStats();
    renderHomeSubjects();
    renderAllSubjects();
  } catch (error) {
    console.error(error);
    const el = document.getElementById('featured-subjects');
    if (el) {
      el.innerHTML = '<div class="col-span-full state-error">Failed to load library data. Check that Subjects.json is valid and this page is served over http(s):// (not opened directly as a file).</div>';
    }
  }
}

function renderStats() {
  const stats = [
    { label: 'Subjects', value: allSubjects.length },
    { label: 'Forms Covered', value: 'I–IV' },
    { label: 'Topics', value: allSubjects.reduce((sum, s) => sum + (s.topics || 0), 0) },
    { label: 'Format', value: 'JSON-first' }
  ];

  document.getElementById('stats').innerHTML = stats.map((item) => `
    <div class="surface bg-white border border-zinc-200 rounded-3xl p-6 shadow-sm">
      <div class="text-3xl md:text-4xl font-semibold tracking-tight">${escapeHtml(item.value)}</div>
      <div class="muted text-zinc-500 mt-2 text-sm uppercase tracking-[0.15em]">${escapeHtml(item.label)}</div>
    </div>
  `).join('');
}

function renderHomeSubjects() {
  const featured = allSubjects.slice(0, 8);
  document.getElementById('featured-subjects').innerHTML = featured.map(renderSubjectCard).join('');
}

function renderAllSubjects() {
  document.getElementById('all-subjects-grid').innerHTML = allSubjects.map(renderSubjectCard).join('');
}

function renderSubjectCard(subject) {
  return `
    <button class="subject-card surface bg-white border border-zinc-200 rounded-3xl p-6 text-left hover:border-emerald-300 hover:shadow-lg w-full"
            onclick="showSubjectDetail('${escapeHtml(subject.id)}')">
      <div class="flex items-start justify-between gap-4">
        <div class="text-5xl">${subject.icon}</div>
        <div class="text-right text-xs font-mono text-emerald-600">${subject.forms.length} FORMS</div>
      </div>
      <div class="heading-font text-2xl font-semibold mt-8">${escapeHtml(subject.name)}</div>
      <p class="muted text-zinc-500 mt-2 text-sm">${subject.topics} topics</p>
    </button>
  `;
}

async function loadSubjectFile(subject) {
  if (subjectCache.has(subject.id)) return subjectCache.get(subject.id);
  const response = await fetch(`./${subject.file}`);
  if (!response.ok) throw new Error(`Could not load ${subject.file}`);
  const data = await response.json();
  subjectCache.set(subject.id, data);
  return data;
}

async function showSubjectDetail(subjectId) {
  const subject = allSubjects.find((item) => item.id === subjectId);
  if (!subject) return;

  currentSubject = subject;
  hideAllPages();
  document.getElementById('subject-detail').classList.remove('hidden');
  document.getElementById('detail-icon').textContent = subject.icon;
  document.getElementById('detail-name').textContent = subject.name;
  document.getElementById('detail-meta').textContent = `${subject.forms.length} Forms • ${subject.topics} Topics`;

  const formsContainer = document.getElementById('forms-container');
  formsContainer.innerHTML = '<p class="muted text-zinc-500">Loading subject content...</p>';

  try {
    const fullData = await loadSubjectFile(subject);
    const cards = Object.entries(fullData.forms || {}).map(([formName, topics]) => `
      <div class="surface bg-white border border-zinc-200 rounded-3xl p-8 shadow-sm">
        <div class="flex justify-between items-center gap-4 mb-6">
          <div class="text-xl font-semibold">${escapeHtml(formName)}</div>
          <div class="text-xs px-4 py-1 bg-emerald-100 text-emerald-700 rounded-3xl">${topics.length} topics</div>
        </div>
        <div class="space-y-3">
          ${topics.map((topic) => `
            <button class="topic-card w-full text-left pl-5 py-3 border-l-2 border-emerald-200 hover:border-emerald-500 rounded-r-2xl hover:bg-emerald-50/60"
                    onclick="showTopic('${escapeHtml(subject.id)}', '${escapeHtml(formName)}', '${escapeHtml(topic)}')">
              ${escapeHtml(topic)}
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');
    formsContainer.innerHTML = cards || '<p class="text-zinc-500">No forms found for this subject.</p>';
    await renderSubjectNotes(subject);
  } catch (error) {
    console.error(error);
    formsContainer.innerHTML = `<div class="col-span-full state-error">Failed to load ${escapeHtml(subject.file)}. Check the filename case matches exactly and the JSON is valid.</div>`;
  }
}

async function renderSubjectNotes(subject) {
  const section = document.getElementById('notes-section');
  const content = document.getElementById('notes-content');

  // notes_file is explicit (from Subjects.json), never guessed from the
  // subject id — some subjects don't have notes yet, and that's fine.
  if (!subject.notes_file) {
    section.classList.add('hidden');
    return;
  }

  try {
    const response = await fetch(`./${subject.notes_file}`);
    if (!response.ok) throw new Error(`Could not load ${subject.notes_file}`);
    const raw = await response.text();

    if (!raw.trim()) {
      // Known data gap (e.g. English/Geography notes files exist but are
      // currently empty) — show an honest message instead of a blank box.
      section.classList.remove('hidden');
      content.innerHTML = '<p class="text-zinc-400 italic">Notes for this subject have not been written yet.</p>';
      return;
    }

    section.classList.remove('hidden');
    // Render as real Markdown (headings, lists, bold, etc.) instead of
    // dumping raw text with # and ** visible — the same class of bug we
    // already fixed once in the SKONGA APK's file-attachment flow.
    content.innerHTML = window.marked ? marked.parse(raw) : `<pre>${escapeHtml(raw)}</pre>`;
  } catch (error) {
    console.error(error);
    section.classList.remove('hidden');
    content.innerHTML = '<p class="text-red-500">Failed to load notes for this subject.</p>';
  }
}

function showTopic(subjectId, form, topicTitle) {
  const subject = allSubjects.find((item) => item.id === subjectId);
  if (!subject) return;

  hideAllPages();
  document.getElementById('topic-view').classList.remove('hidden');
  document.getElementById('topic-breadcrumb').innerHTML = `
    <button onclick="navigateTo('home')" class="hover:underline text-zinc-500 dark:text-zinc-300">Home</button>
    <span>›</span>
    <button onclick="showSubjectDetail('${escapeHtml(subject.id)}')" class="hover:underline text-zinc-500 dark:text-zinc-300">${escapeHtml(subject.name)}</button>
    <span>›</span>
    <span>${escapeHtml(form)}</span>
    <span>›</span>
    <span class="font-medium text-zinc-900 dark:text-white">${escapeHtml(topicTitle)}</span>
  `;

  document.getElementById('topic-header').innerHTML = `
    <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        <span class="inline-block px-5 py-1 text-xs font-mono bg-emerald-100 text-emerald-700 rounded-3xl">${escapeHtml(form)}</span>
        <h1 class="heading-font text-4xl md:text-5xl font-semibold mt-4 leading-none">${escapeHtml(topicTitle)}</h1>
        <p class="muted text-zinc-500 mt-4 max-w-2xl">Structured overview for ${escapeHtml(subject.name)} aligned to the Tanzanian secondary syllabus.</p>
      </div>
      <div class="soft bg-zinc-100 rounded-3xl px-5 py-4 text-sm text-zinc-600">
        <div><strong>Subject:</strong> ${escapeHtml(subject.name)}</div>
        <div><strong>Form:</strong> ${escapeHtml(form)}</div>
      </div>
    </div>
  `;

  document.getElementById('topic-body').innerHTML = `
    <div class="surface bg-white border border-zinc-200 rounded-3xl p-8 md:p-10 shadow-sm">
      <p class="text-lg">This topic page is ready for SKONGA AI notes, teacher summaries, and exam preparation content. Right now it provides a clean structured shell for <strong>${escapeHtml(topicTitle)}</strong>.</p>
      <h3>Study checklist</h3>
      <ul>
        <li>Define the topic in simple classroom language.</li>
        <li>List the main concepts, principles, or components students must know.</li>
        <li>Connect the topic to practical examples from daily life or national exams.</li>
        <li>Highlight common mistakes and revision tips.</li>
      </ul>
      <h3>Suggested expansion</h3>
      <p>Add markdown notes or generated lesson content per topic later, while keeping this JSON-based navigation unchanged.</p>
      <div class="soft mt-8 rounded-3xl bg-emerald-50 border border-emerald-100 p-6 text-emerald-900">
        <strong>Ready for next phase:</strong> per-topic notes, flashcards, quizzes, offline caching, and teacher mode.
      </div>
    </div>
  `;

  currentTopicData = {
    subject: subject.name,
    subjectId: subject.id,
    form,
    topic: topicTitle
  };
}

function downloadCurrentTopic() {
  if (!currentTopicData) return;
  const jsonString = JSON.stringify(currentTopicData, null, 2);
  const blob = new Blob([jsonString], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(currentTopicData.topic || 'topic')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function hideAllPages() {
  ['home-page', 'subjects-page', 'subject-detail', 'topic-view', 'about-page'].forEach((id) => {
    document.getElementById(id).classList.add('hidden');
  });
}

function navigateTo(page) {
  hideAllPages();
  if (page === 'home') {
    document.getElementById('home-page').classList.remove('hidden');
  } else if (page === 'subjects') {
    document.getElementById('subjects-page').classList.remove('hidden');
    renderAllSubjects();
  } else if (page === 'about') {
    document.getElementById('about-page').classList.remove('hidden');
  }
}

function showSearch() {
  document.getElementById('search-overlay').classList.remove('hidden');
  document.getElementById('search-input').focus();
}

function hideSearchOverlay() {
  document.getElementById('search-overlay').classList.add('hidden');
}

let searchToken = 0;

function executeSearch() {
  const term = document.getElementById('search-input').value.toLowerCase().trim();
  const container = document.getElementById('search-results-container');
  const thisSearch = ++searchToken;

  if (!term) {
    container.innerHTML = '<div class="px-6 py-12 text-center text-zinc-400">Type a subject or topic name.</div>';
    return;
  }

  const results = [];
  allSubjects.forEach((subject) => {
    if (subject.name.toLowerCase().includes(term)) {
      results.push({ type: 'subject', subject });
    }
    loadSubjectFile(subject).then((data) => {
      if (thisSearch !== searchToken) return; // stale search, ignore
      Object.entries(data.forms || {}).forEach(([formName, topics]) => {
        topics.filter((topic) => topic.toLowerCase().includes(term)).forEach((topic) => {
          results.push({ type: 'topic', subject, formName, topic });
        });
      });
      renderSearchResults(results, term);
    }).catch(() => {
      if (thisSearch === searchToken) renderSearchResults(results, term);
    });
  });

  renderSearchResults(results, term);
}

function renderSearchResults(results, term) {
  const container = document.getElementById('search-results-container');
  const deduped = [];
  const seen = new Set();
  results.forEach((item) => {
    const key = JSON.stringify([item.type, item.subject?.id, item.formName, item.topic]);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  });

  if (!deduped.length) {
    container.innerHTML = `<div class="px-8 py-14 text-center text-zinc-500">No matches for <span class="font-medium">${escapeHtml(term)}</span>.</div>`;
    return;
  }

  container.innerHTML = `<div class="space-y-2 p-2">${deduped.map((item) => {
    if (item.type === 'subject') {
      return `
        <button onclick="hideSearchOverlay(); showSubjectDetail('${escapeHtml(item.subject.id)}')"
                class="w-full text-left px-5 py-5 hover:bg-zinc-50 rounded-2xl flex items-center gap-4 text-zinc-900 dark:text-white">
          <span class="text-3xl">${item.subject.icon}</span>
          <div>
            <div class="font-medium">${escapeHtml(item.subject.name)}</div>
            <div class="text-xs text-emerald-600">Subject • ${item.subject.topics} topics</div>
          </div>
        </button>
      `;
    }
    return `
      <button onclick="hideSearchOverlay(); showTopic('${escapeHtml(item.subject.id)}', '${escapeHtml(item.formName)}', '${escapeHtml(item.topic)}')"
              class="w-full text-left px-5 py-5 hover:bg-zinc-50 rounded-2xl flex items-center gap-4 text-zinc-900 dark:text-white">
        <span class="text-3xl">${item.subject.icon}</span>
        <div>
          <div class="font-medium">${escapeHtml(item.topic)}</div>
          <div class="text-xs text-emerald-600">${escapeHtml(item.subject.name)} • ${escapeHtml(item.formName)}</div>
        </div>
      </button>
    `;
  }).join('')}</div>`;
}

function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  try {
    localStorage.setItem('skonga-theme', isDark ? 'dark' : 'light');
  } catch (e) {
    /* localStorage unavailable, ignore */
  }
}

function initTheme() {
  try {
    const saved = localStorage.getItem('skonga-theme');
    if (saved === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {
    /* localStorage unavailable, ignore */
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initData();
  document.getElementById('hero-search-input').addEventListener('focus', showSearch);
  document.getElementById('hero-search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      document.getElementById('search-input').value = event.target.value;
      showSearch();
      executeSearch();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.getElementById('search-overlay').classList.contains('hidden')) {
      event.preventDefault();
      showSearch();
    }
    if (event.key === 'Escape') {
      hideSearchOverlay();
    }
  });
});