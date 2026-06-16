# Arquitetura do oc-proxy

Um proxy reverso baseado em Fastify que fica entre o OpenCode e a API NVIDIA NIM, serializando e limitando requisições para permanecer dentro do rate limit. Rastreia uso de tokens para inferência de TPM.

## Estrutura

```
proxy.mjs                    # Entry point fino → src/index.js
runners/
├── migrate.js               # CLI: aplicar/reverter migrações
├── migration.js             # CLI: criar migração / status
└── migrate-utils.js         # Utilitários compartilhados de migração
migrations/                  # Arquivos de migração timestamped
src/
├── index.js                 # Raiz de composição — conecta todas as dependências
├── config.js                # Objeto de configuração congelado a partir de env vars
├── domain/
│   ├── rate-limiter.js      # Enforcer RPM + Enforcer TPM + fábrica de composição
│   ├── token-tracker.js     # Registro de uso, estimativa, resumo
│   ├── model-injector.js    # Array de regras de modelo configurável
│   └── scheduler.js         # Fila de jobs, concorrência, espaçamento entre disparos
├── infrastructure/
│   ├── database/
│   │   ├── connection.js    # SQLite (better-sqlite3) com WAL + ensureInfrastructure()
│   │   ├── snowflake.js     # Gerador de IDs BigInt de 64 bits
│   │   ├── requests-repository.js  # CRUD de requisições + agregações
│   │   ├── throttle-repository.js  # Singleton de estado + log de eventos + estado por modelo
│   │   ├── buffered-repository.js  # Decorador de buffer write-behind
│   │   └── legacy-migration.js     # nim-throttle-state.json → SQLite
│   ├── auth-loader.js       # Leitor de auth.json com cache
│   ├── nim-client.js        # HTTP fetch com retry
│   └── tokenizer.js         # Wrapper para js-tiktoken
└── presentation/
    ├── routes.js            # Ponte rota Fastify → fila
    ├── sse-tap.js           # Stream Transform SSE transparente
    └── server.js            # App Fastify, listen, inicialização
```

## Grafo de Dependências

```
index.js (raiz de composição)
  ├── config.js
  ├── infrastructure/tokenizer.js
  ├── infrastructure/database/connection.js ← config
  ├── infrastructure/database/snowflake.js
  ├── infrastructure/database/requests-repository.js ← connection, snowflake
  ├── infrastructure/database/throttle-repository.js ← connection, snowflake
  ├── infrastructure/database/buffered-repository.js ← repos requests/throttle
  ├── infrastructure/database/legacy-migration.js ← buffered-repo, throttle-repo
  ├── infrastructure/auth-loader.js ← config
  ├── domain/rate-limiter.js ← config
  ├── domain/token-tracker.js ← tokenizer, rate-limiter
  ├── domain/model-injector.js ← config
  ├── domain/scheduler.js ← rate-limiter, config
  ├── infrastructure/nim-client.js ← auth-loader, model-injector, config
  ├── presentation/sse-tap.js ← tokenizer, token-tracker
  ├── presentation/routes.js ← scheduler
  └── presentation/server.js ← fastify
```

## Princípios SOLID

| Princípio | Aplicação |
|---|---|
| **Responsabilidade Única** | Cada módulo faz uma coisa. `rate-limiter.js` expõe três funções: `createRpmEnforcer` (disparos globais + cooldown), `createTpmEnforcer` (tokens por modelo + pendentes), e `createRateLimiter` (fábrica de composição). `nim-client.js` não sabe sobre estado. |
| **Aberto/Fechado** | Novo modelo? Adicione uma regra em `config.thinkingModels`. Nova estratégia de rate limit? Novo arquivo em `domain/`. |
| **Substituição de Liskov** | `nim-client.js` expõe uma interface `send()`. Poderia trocar NIM por qualquer API compatível com OpenAI. |
| **Segregação de Interfaces** | Repositórios expõem métodos focados (`insert()`, `findByModel()`) — não um gerenciador de DB inchado. |
| **Inversão de Dependência** | `scheduler.js` recebe uma função `processJob` via construtor. Dependências são injetadas em `index.js`. |

## Fluxo de Requisição

1. **Rota** (`/v1/*`): Requisição interceptada, `reply.hijack()` assume o controle, job enviado para a fila.

2. **Scheduler**: Loop em background verifica cooldown, concorrência, janela deslizante (RPM + TPM) e espaçamento entre disparos antes de desenfileirar.

3. **processJob** (raiz de composição): Carrega chave da API, modifica o body via model injector, envia upstream via nim-client com lógica de retry. Toda requisição (sucesso ou erro) é persistida em SQLite via repositório bufferizado.

4. **Resposta**: Respostas SSE são pipeadas através do `SSETapStream` transparente para contagem de tokens. Respostas não-SSE são analisadas para extrair dados de uso.

5. **Rastreio de tokens**: Uso registrado com o campo `usage` da NIM ou estimativa `js-tiktoken`. Persistido na tabela `requests` do SQLite, registrado em nível info.

## Limitador de Taxa (5 camadas)

### Camada 1 — Janela Deslizante (baseada em disparos)
`dispatchTimestamps[]` rastreia quando as requisições saem do proxy. `MAX_RPM` (padrão 25) por janela de 60 segundos.

### Camada 2 — Janela de Tokens (TPM, por modelo)
Cada modelo tem seu próprio `tokenTimestamps[]` em janela deslizante de 60s. `MAX_TPM` (padrão 250K) por modelo por janela. Antes do disparo, o custo estimado (tokens de prompt do `js-tiktoken` + `COMPLETION_BUFFER`) **mais tokens pendentes em voo** é verificado contra o orçamento disponível. Tokens pendentes são subtraídos na conclusão (mínimo 0). Rotas não-inference (`/v1/models`, etc.) pulam a verificação TPM. Composta como porta AND com RPM — ambas devem passar.

### Camada 3 — Limitador de Concorrência
`MAX_CONCURRENCY` (padrão 2) requisições upstream em andamento no máximo.

### Camada 4 — Espaçamento entre Disparos (proporcional a tokens)
Gap mínimo = `max(MIN_DISPATCH_GAP_MS, ceil(estimado * 60000 / MAX_TPM))`. Custos maiores de tokens espaçam mais os disparos, suavizando rajadas de requisições caras.

### Camada 5 — Retry 429 + Cooldown + Persistência de Estado
Retry até `MAX_RETRIES` (padrão 3) com `RETRY_DELAYS` (20s, 40s, 60s). Se todos falharem: `COOLDOWN_MINUTES` (padrão 60) de cooldown + `adaptiveLimit--` (mínimo 5) + persiste todos os estados TPM por modelo na tabela `model_throttle_state`.

## Rastreamento de Uso de Tokens

O uso de tokens de toda requisição é interceptado e registrado:
- **SSE streaming**: `SSETapStream` transparente analisa eventos em trânsito. Conta `delta.content` e `delta.reasoning_content`. Também analisa linhas de comentário `:` da NIM para `input_tokens`/`output_tokens` exatos.
- **Não-SSE**: extrai o campo `usage` da NIM. Fallback para `js-tiktoken` (verifica `reasoning_content` para modelos de pensamento).
- **Detecção SSE**: lê o header `content-type` da resposta, não o `Accept` da requisição.
- **Estimativa**: `js-tiktoken` com codificação `cl100k_base`.

Persistido na tabela `requests` do SQLite. Escrito via `BufferedRepository` (buffer write-behind com descarga em lote). Veja `src/infrastructure/database/` para as implementações dos repositórios.

## Camada de Persistência

Configurável via env vars. Tabelas principais:

- **`requests`** — toda requisição proxyficada com modelo, tokens, latência, status de erro, flag SSE. IDs Snowflake.
- **`throttle_events`** — log somente de acréscimo de eventos de cooldown e mudanças de limite. IDs Snowflake.
- **`throttle_state`** — linha singleton com `adaptiveLimit` e `cooldownUntil` atuais.
- **`model_throttle_state`** — estado da janela deslizante por modelo (`token_timestamps`, `pending_tokens`, `updated_at`). Persistido no cooldown, carregado na inicialização.
- **`_schema_version`** — rastreia versões de migração aplicadas (BigInt).
- **`_migration_lock`** — lock atômico para segurança de migração concorrente.

Mudanças de schema são gerenciadas via arquivos de migração timestamped em `migrations/`. Aplique com `npm run migrate`. Veja README.pt-BR.md para uso da CLI.

A poda TTL é executada a cada hora; retenção configurada via `DB_RETENTION_DAYS`.

## Configuração

Todas as constantes configuráveis via env vars. Consulte README.pt-BR.md para a lista completa.

## Testes

```bash
yarn test        # executar todos os testes
yarn test:watch  # modo watch
```

Testes em `tests/domain/` e `tests/infrastructure/` usam vitest.
