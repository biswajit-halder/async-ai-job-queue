const apiBase = document.querySelector('#apiBase');
const examplesEl = document.querySelector('#examples');
const submitBtn = document.querySelector('#submit');
const resultEl = document.querySelector('#result');
const errorEl = document.querySelector('#error');
const badges = document.querySelector('#badges');

let selected = null;

function base() {
  return apiBase.value.trim().replace(/\/$/, '');
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

function renderResult(value) {
  resultEl.querySelector('code').textContent = JSON.stringify(value, null, 2);
}

async function loadExamples() {
  showError('');
  try {
    const res = await fetch(`${base()}/v1/demo/examples`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    examplesEl.innerHTML = '';
    for (const example of data.examples) {
      const button = document.createElement('button');
      button.className = 'example';
      button.textContent = example.label;
      button.addEventListener('click', () => {
        selected = example.label;
        for (const node of examplesEl.querySelectorAll('.example')) node.classList.remove('active');
        button.classList.add('active');
        submitBtn.disabled = false;
        renderResult({ selected: example.label, preview: example.preview });
      });
      examplesEl.appendChild(button);
    }
  } catch (error) {
    showError(`Could not load examples: ${error.message}. Check the API base URL.`);
  }
}

async function poll(id) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const res = await fetch(`${base()}/v1/demo/jobs/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Poll failed: HTTP ${res.status}`);
    const job = await res.json();
    renderResult(job);
    if (job.status === 'completed') return job;
    if (job.status === 'failed' || job.status === 'dead_letter') {
      throw new Error(job.error ?? 'Job failed');
    }
  }
  throw new Error('Timed out waiting for the job');
}

submitBtn.addEventListener('click', async () => {
  if (!selected) return;
  submitBtn.disabled = true;
  showError('');
  try {
    const res = await fetch(`${base()}/v1/demo/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: selected }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
    renderResult({ id: data.id, status: data.status });
    badges.innerHTML = '<span class="badge">job queued</span>';
    const finished = await poll(data.id);
    badges.innerHTML = `<span class="badge">${finished.status}</span><span class="badge">cache ${finished.result ? 'ready' : 'n/a'}</span>`;
  } catch (error) {
    showError(error.message);
  } finally {
    submitBtn.disabled = false;
  }
});

apiBase.addEventListener('change', loadExamples);
loadExamples();
