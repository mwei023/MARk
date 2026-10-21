import json
from datetime import datetime, timedelta
from pathlib import Path

root = Path(__file__).resolve().parents[2]
out = root / 'data' / 'training' / 'routing.jsonl'
out.parent.mkdir(parents=True, exist_ok=True)


def build_variants(prefixes, subjects, suffixes=None):
    items = []
    suffixes = suffixes or ['']
    for prefix in prefixes:
        for subject in subjects:
            for suffix in suffixes:
                combined = f"{prefix} {subject} {suffix}".strip()
                if combined:
                    items.append(combined)
    return items

# IMPORTANT: these labels mirror the live gateway routing precedence, not stale
# assumptions from earlier buggy seeds. The route order is intentionally:
# 1) information / explanatory / directory lookup -> reasoning
# 2) local host metrics -> deterministic
# 3) system inspection -> system-agent
# 4) service health -> devops-agent
# 5) CI/CD status -> cicd-agent
# 6) git / repo -> git-agent
# 7) code repair -> code-agent
# 8) web research -> web-agent
# 9) deep research -> research-agent

deterministic = build_variants(
    ['check', 'show', 'display', 'what is the', 'what is', 'tell me the'],
    [
        'cpu usage', 'memory usage', 'disk usage', 'disk space', 'free disk space',
        'available memory', 'free memory', 'current time', 'current date', 'system clock',
        'storage usage', 'system config', 'llm provider', 'model configuration',
        'project root files', 'home folder contents', 'working directory contents',
        'local directory listing', 'available disk', 'current load', 'memory pressure',
        'CPU load', 'host resource usage', 'local storage', 'system status'
    ],
    ['today', 'right now', 'currently', 'on this machine', 'for this host']
) + [
    'what time is it', 'what date is it', 'check my CPU usage', 'show CPU usage',
    'check disk space', 'check memory usage', 'show memory usage', 'show current disk usage',
    'show system clock', 'tell me the time', 'what is the current time', 'show local storage usage',
    'check available memory', 'show free memory', 'show free disk space', 'check current CPU load',
    'show current memory pressure', 'show current system load', 'show host resource usage',
    'list workspace files', 'show directory listing', 'display my directory', 'show files in the repo root',
    'show my home directory', 'show the contents of the downloads folder', 'list my files',
    'display the local file tree', 'show me the current directory contents'
]

reasoning = build_variants(
    ['explain', 'teach me', 'help me understand', 'show me a simple explanation of', 'what is', 'how does', 'why does', 'why is', 'can you explain', 'can you help me learn'],
    [
        'docker', 'git', 'load balancing', 'a container', 'caching', 'a queue',
        'version control', 'a database', 'an LLM', 'a mutex', 'recursion', 'an event loop',
        'a service mesh', 'a reverse proxy', 'Kubernetes', 'a branch in git', 'REST', 'HTTP',
        'a queue', 'microservices', 'dependency injection', 'a hash map', 'a database index',
        'a system call', 'the software release process', 'a CI pipeline', 'a deployment',
        'a distributed system', 'the request lifecycle', 'telemetry', 'DNS', 'NoSQL', 'SQL',
        'the home directory', 'the downloads directory', 'the documents directory', 'the project root',
        'the workspace', 'the repo folder', 'the local folder contents', 'the current directory contents'
    ],
    ['in simple terms', 'for beginners', 'with an example', 'in plain English', 'in one sentence']
) + [
    'help me learn Python', 'help me learn JavaScript', 'what is in the home directory',
    'what is in the downloads directory', 'what is in the documents directory',
    'list the files in my directory', 'show files in my home directory', 'show file names in the home directory',
    'show the contents of the home folder', 'what is in the project root', 'show me a simple explanation of Docker',
    'teach me how git works', 'how does caching work', 'why do we need version control',
    'what is a container', 'what is load balancing', 'what is a database', 'what is DNS',
    'what is a reverse proxy', 'how does a web server work', 'explain HTTP requests',
    'help me understand microservices', 'why are tests important', 'what is a mutex',
    'what is recursion', 'what is an event loop', 'what is an LLM', 'show me the local folder contents',
    'what is the difference between SQL and NoSQL', 'what is a service mesh', 'what is a REST endpoint',
    'can you explain dependency injection', 'help me understand Kubernetes', 'what is telemetry',
    'what is in the documents folder', 'list files in downloads', 'show me the files in the home directory',
    'what is in the workspace directory', 'tell me what is in my home folder'
]

system_agent = build_variants(
    ['is', 'check if', 'show', 'list', 'what is', 'are there'],
    [
        'postgres running', 'redis running', 'mysql running', 'nginx running', 'the web server running',
        'the api server running', 'the worker running', 'the database running', 'redis up', 'postgres up',
        'the app running', 'the service running', 'the daemon running', 'the process running',
        'running services', 'active processes', 'open ports', 'listening ports', 'network connections',
        'system logs', 'current system load', 'recent system logs', 'running daemons'
    ],
    ['right now', 'currently', 'on this host', 'on this machine']
) + [
    'what is running?', 'is postgres running', 'is redis running', 'show active processes',
    'list running processes', 'show open ports', 'show process tree', 'show system information',
    'check system status', 'inspect running services', 'check if the database is up',
    'show current system load', 'show network connections', 'list system services',
    'show host resource usage', 'check the process health', 'show system logs',
    'check if the API worker is active', 'show recent system logs', 'list running daemons',
    'show hardware status', 'show running services'
]

git_agent = build_variants(
    ['git', 'show', 'check', 'list', 'review'],
    [
        'status', 'branch', 'branches', 'log', 'recent commits', 'changed files', 'staged files',
        'tracked branches', 'repo status', 'repo branches', 'working tree', 'remotes', 'remote status',
        'diff', 'merge status', 'rebase status', 'branch divergence', 'commit history', 'HEAD state'
    ],
    ['now', 'for this repo', 'in this repository', 'on this branch']
) + [
    'git status', 'git branch', 'show branch list', 'git checkout main', 'git fetch origin', 'git log',
    'show recent commits', 'git diff', 'check repo status', 'show changed files', 'what branch am I on',
    'git status --short', 'git branch --all', 'show active branch', 'check if there are uncommitted changes',
    'show repository branches', 'list remotes', 'show the repo remotes', 'check if the repo is dirty',
    'show last 20 commits', 'review git history', 'check for detached HEAD', 'show git working tree',
    'show repository state', 'check if main is ahead', 'show branch divergence', 'show recent branch activity',
    'check for merges pending', 'check repository health', 'git pull --rebase', 'show repo status',
    'list tracked branches', 'show the repo log', 'show current branch'
]

devops_agent = build_variants(
    ['check', 'show', 'inspect', 'restart', 'start', 'stop', 'scale', 'redeploy', 'rollback', 'recover'],
    [
        'service health', 'deployment status', 'pod status', 'kubernetes pods', 'ingress status',
        'service readiness', 'health endpoint', 'web service status', 'api service status',
        'database service', 'gateway service', 'nginx', 'postgres', 'container health', 'cluster health',
        'running workloads', 'service configuration', 'environment health', 'deployment health', 'app status'
    ],
    ['now', 'right now', 'for production', 'for staging', 'for this environment']
) + [
    'deploy to staging', 'deploy to production', 'rollback the deploy', 'restart the container',
    'restart nginx', 'restart postgres', 'start the web service', 'restart the api service',
    'check service health', 'show pod status', 'redeploy the service', 'check if the service is healthy',
    'scale the service', 'check ingress status', 'show kubernetes pods', 'deploy the app to staging',
    'roll back the last release', 'show running services', 'restart the app server', 'check deployment status',
    'show running pods', 'inspect service configuration', 'show environment health', 'check service readiness',
    'restart the database service', 'restart the gateway service', 'show service dependencies',
    'show running workloads', 'check if the web app is up', 'show health endpoint status', 'list active services',
    'check the docker container health', 'show the deployment health'
]

cicd_agent = build_variants(
    ['check', 'show', 'verify', 'review', 'is the', 'did the'],
    [
        'pipeline status', 'build status', 'CI status', 'workflow status', 'job status', 'test suite status',
        'release gate status', 'build health', 'pipeline health', 'workflow health', 'CI signal',
        'branch checks', 'lint status', 'failing job', 'latest build logs', 'latest pipeline run',
        'deployment validation logs', 'test results', 'pipeline run status'
    ],
    ['right now', 'for this branch', 'for this commit', 'currently']
) + [
    'show pipeline status', 'check CI status', 'is the pipeline green', 'is the build passing',
    'check build status', 'what is the status of the pipeline', 'is the deployment pipeline healthy',
    'check the pipeline health', 'show the latest build logs', 'did the tests pass', 'show the failing job',
    'review the test results', 'inspect failing tests', 'show lint errors', 'run the test suite',
    'run the build', 'show the release gate status', 'verify test suite status', 'show CI summary',
    'check if lint is failing', 'read the last build log', 'show the latest pipeline run',
    'review deployment validation logs', 'check if my PR is green', 'show CI signal',
    'verify the branch checks', 'why is the pipeline red', 'show the status of the workflow',
    'check if the build is healthy', 'is the release pipeline passing'
]

code_agent = build_variants(
    ['fix', 'repair', 'debug', 'resolve', 'patch'],
    [
        'the lint errors', 'the TypeScript errors', 'this failing test', 'the compile error',
        'the runtime bug', 'the regression', 'the broken function', 'the syntax error',
        'the type mismatch', 'the data flow bug', 'the null pointer', 'the import error',
        'the failing build', 'the auth bug', 'the cache invalidation issue', 'the sorting bug',
        'the schema mismatch', 'the null check', 'the validation bug', 'the config loader',
        'the JSON parsing bug', 'the event handler bug', 'the runtime exception path',
        'the API contract', 'the merge conflict in code'
    ],
    ['now', 'for this repo', 'in this project', 'in the codebase']
) + [
    'repair the lint errors', 'fix the TypeScript errors', 'debug this failing test', 'resolve the compile error',
    'fix the runtime bug', 'patch the regression', 'repair the broken function', 'fix the syntax error',
    'resolve the type mismatch', 'repair the data flow bug', 'debug the null pointer', 'fix the import error',
    'resolve the failing build', 'repair the auth bug', 'patch the cache invalidation issue',
    'fix the sorting bug', 'debug the schema mismatch', 'repair the null check', 'fix the missing import',
    'repair the API contract', 'fix the validation bug', 'patch the config loader', 'repair the JSON parsing bug',
    'resolve the merge conflict in code', 'fix the event handler bug', 'repair the runtime exception path',
    'fix the broken import order', 'debug the async race condition'
]

web_agent = build_variants(
    ['search', 'browse', 'look up', 'check', 'verify', 'look for'],
    [
        'Docker docs', 'FastAPI docs', 'TypeScript config examples', 'the docs site', 'the status page',
        'the project website', 'API reference', 'deployment docs', 'Redis benchmarking results',
        'the login page', 'the docs link', 'the release notes', 'support links', 'forum answers',
        'Python packaging docs', 'React tutorials', 'database sharding docs', 'LLM eval papers'
    ],
    ['online', 'on the web', 'on the internet', 'for a reference']
) + [
    'look up flights to Nairobi', 'search the web for docker tutorials', 'check the docs link',
    'is the login page working', 'verify the website URL', 'browse the documentation for FastAPI',
    'look up the release notes', 'check if the linked docs are alive', 'search for pandas docs',
    'search for TypeScript config examples', 'look up the API reference', 'check the link to the docs site',
    'verify the support link', 'check if the project website is up', 'search for Redis benchmarking results',
    'browse Docker docs', 'search the internet for async patterns', 'look up the status page',
    'find a health check example', 'look up a Docker tutorial', 'search the docs for Kubernetes examples'
]

research_agent = build_variants(
    ['deep research', 'deep dive into', 'survey the field of', 'investigate', 'literature review of', 'research'],
    [
        'vector databases', 'retrieval systems', 'reinforcement learning', 'graph databases',
        'database sharding', 'LLM serving infrastructure', 'microservices patterns', 'LLM evaluation',
        'message queues', 'agent orchestration', 'container runtime security', 'zero trust architecture',
        'publish subscribe systems', 'data pipelines', 'observability tooling', 'supply chain security',
        'database replication', 'distributed tracing', 'feature stores', 'fault tolerance'
    ],
    ['in depth', 'thoroughly', 'with a literature review', 'for the current state of the art']
) + [
    'deep research vector databases', 'deep research retrieval systems', 'deep dive into reinforcement learning',
    'survey the field of graph databases', 'investigate database sharding in depth', 'research LLM serving infrastructure',
    'literature review of microservices patterns', 'survey state of the art in LLM evaluation',
    'deep research on message queues', 'map the field of agent orchestration', 'deep research on container runtime security',
    'investigate zero trust architecture', 'thoroughly review publish subscribe systems', 'deep research on data pipelines',
    'survey the field of observability tooling', 'research secure software supply chain patterns',
    'deep research on database replication', 'research service mesh architectures', 'deep research on distributed tracing'
]

labels = [
    ('deterministic', deterministic),
    ('reasoning', reasoning),
    ('agent:system-agent', system_agent),
    ('agent:git-agent', git_agent),
    ('agent:devops-agent', devops_agent),
    ('agent:cicd-agent', cicd_agent),
    ('agent:code-agent', code_agent),
    ('agent:web-agent', web_agent),
    ('agent:research-agent', research_agent),
]

rows = []
MAX_PER_LABEL = 600
LABEL_PRIORITY = {
    'reasoning': 0,
    'deterministic': 1,
    'agent:system-agent': 2,
    'agent:devops-agent': 3,
    'agent:cicd-agent': 4,
    'agent:git-agent': 5,
    'agent:code-agent': 6,
    'agent:web-agent': 7,
    'agent:research-agent': 8,
}
AMBIGUOUS_TEXTS = {
    'show current system load': 'agent:system-agent',
    'show host resource usage': 'agent:system-agent',
    'show running services': 'agent:system-agent',
    'show current memory pressure': 'deterministic',
    'show system information': 'agent:system-agent',
    'check system status': 'agent:system-agent',
    'check nginx now': 'agent:system-agent',
    'check nginx right now': 'agent:system-agent',
    'check nginx for this environment': 'agent:system-agent',
    'check postgres now': 'agent:system-agent',
    'check postgres right now': 'agent:system-agent',
    'check postgres for this environment': 'agent:system-agent',
    'check redis now': 'agent:system-agent',
    'check redis right now': 'agent:system-agent',
    'check redis for this environment': 'agent:system-agent',
    'check running workloads now': 'agent:system-agent',
    'check running workloads right now': 'agent:system-agent',
    'check running workloads for this environment': 'agent:system-agent',
    'check service configuration now': 'deterministic',
    'check service configuration right now': 'deterministic',
    'check service configuration for production': 'deterministic',
    'check service configuration for staging': 'deterministic',
    'check service configuration for this environment': 'deterministic',
    'check build health right now': 'agent:cicd-agent',
    'check build health for this branch': 'agent:cicd-agent',
    'check build health for this commit': 'agent:cicd-agent',
    'check build health currently': 'agent:cicd-agent',
    'check pipeline health right now': 'agent:cicd-agent',
    'check pipeline health for this branch': 'agent:cicd-agent',
    'check pipeline health for this commit': 'agent:cicd-agent',
    'check pipeline health currently': 'agent:cicd-agent',
    'check workflow health right now': 'agent:cicd-agent',
    'check workflow health for this branch': 'agent:cicd-agent',
    'check workflow health for this commit': 'agent:cicd-agent',
    'check workflow health currently': 'agent:cicd-agent',
    'check CI signal for this branch': 'agent:cicd-agent',
    'check CI signal for this commit': 'agent:cicd-agent',
    'check branch checks right now': 'agent:cicd-agent',
    'search Docker docs online': 'agent:web-agent',
    'search Docker docs on the web': 'agent:web-agent',
    'search Docker docs on the internet': 'agent:web-agent',
    'search Docker docs for a reference': 'agent:web-agent',
    'search the status page online': 'agent:web-agent',
    'search the status page on the web': 'agent:web-agent',
    'search the status page on the internet': 'agent:web-agent',
    'search the status page for a reference': 'agent:web-agent',
    'search the project website online': 'agent:web-agent',
    'search the project website on the web': 'agent:web-agent',
    'search the project website on the internet': 'agent:web-agent',
    'search the project website for a reference': 'agent:web-agent',
    'search deployment docs online': 'agent:web-agent',
    'search deployment docs on the web': 'agent:web-agent',
    'search deployment docs on the internet': 'agent:web-agent',
    'show service configuration now': 'deterministic',
    'show service configuration right now': 'deterministic',
    'show service configuration for production': 'deterministic',
    'show service configuration for staging': 'deterministic',
    'show service configuration for this environment': 'deterministic',
    'check app status now': 'agent:cicd-agent',
    'check app status right now': 'agent:cicd-agent',
    'check app status for this environment': 'agent:cicd-agent',
}

# Explicit overlap fixes: these are the “boundary” examples that teach the model
# the difference between a status check, a system/runtime check, and a local fact.
SEMANTIC_FIXES = {
    'deterministic': [
        'check cpu usage', 'check memory usage', 'check disk space', 'show free memory',
        'show free disk space', 'show current time', 'show current date', 'show local file tree',
        'list workspace files', 'show project root files', 'show home folder contents'
    ],
    'agent:system-agent': [
        'is postgres running', 'is redis running', 'is nginx running', 'show active processes',
        'list listening ports', 'show process tree', 'show recent system logs',
        'check if the api worker is active', 'show running daemons', 'show open ports'
    ],
    'agent:devops-agent': [
        'check service health', 'check deployment status', 'show pod status', 'check ingress status',
        'restart nginx', 'restart postgres', 'redeploy the service', 'check if the service is healthy',
        'show running workloads', 'roll back the last release', 'scale the service'
    ],
    'agent:cicd-agent': [
        'show build status', 'check pipeline health', 'check workflow health', 'show CI summary',
        'review test results', 'show failing job', 'check branch checks', 'show latest build logs',
        'did the tests pass', 'check if lint is failing', 'is the pipeline green', 'show pipeline status'
    ],
    'agent:code-agent': [
        'fix the failing build', 'repair the syntax error', 'debug this failing test',
        'fix the runtime bug', 'repair the null pointer', 'resolve the compile error',
        'patch the regression', 'fix the broken import order', 'repair the type mismatch'
    ],
    'agent:web-agent': [
        'search Docker docs', 'search FastAPI docs', 'look up the status page',
        'browse the documentation for FastAPI', 'look up the release notes', 'check the docs link'
    ],
    'reasoning': [
        'explain docker in simple terms', 'what is load balancing', 'teach me how git works',
        'help me understand microservices', 'what is a container', 'what is a database'
    ],
}

seen: dict[str, str] = {}
per_label: dict[str, list[str]] = {label: [] for label, _ in labels}
for label, texts in labels:
    for text in texts:
        normalized = ' '.join(text.lower().split())
        if normalized in AMBIGUOUS_TEXTS and AMBIGUOUS_TEXTS[normalized] != label:
            continue
        if normalized in seen and seen[normalized] != label:
            current = seen[normalized]
            # Explicit precedence for overlapping phrases. Runtime precedence wins.
            if LABEL_PRIORITY[label] < LABEL_PRIORITY[current]:
                seen[normalized] = label
                per_label[current] = [item for item in per_label[current] if ' '.join(item.lower().split()) != normalized]
                per_label[label].append(text)
            continue
        if normalized in seen:
            continue
        seen[normalized] = label
        per_label[label].append(text)

rows = []
for label, _ in labels:
    unique = list(dict.fromkeys(per_label[label]))
    for text in unique[:MAX_PER_LABEL]:
        ts = (datetime(2026, 10, 18, 0, 0, 0) + timedelta(minutes=len(rows))).isoformat() + 'Z'
        rows.append({
            'text': text,
            'label': label,
            'predicted': label,
            'agree': True,
            'source': 'synthetic',
            'ts': ts,
        })

# Write a balanced, deduplicated dataset in JSONL format.
with out.open('w', encoding='utf-8') as f:
    for row in rows:
        f.write(json.dumps(row, ensure_ascii=False) + '\n')

print(f'wrote {len(rows)} rows to {out}')
print(f'labels: {sorted({row["label"] for row in rows})}')
print(f'per-label counts: { {label: sum(1 for row in rows if row["label"] == label) for label, _ in labels} }')
