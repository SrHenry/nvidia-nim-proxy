# NVIDIA NIM Proxy

Um proxy reverso que serializa e limita requisições do OpenCode à API NVIDIA NIM, rastreia uso de tokens e faz retry em rate limits.

## Visão Geral

O comportamento padrão do OpenCode dispara requisições concorrentes que rapidamente excedem o rate limit da NVIDIA NIM. O oc-proxy fica entre os dois, enfileirando requisições através de um limitador de janela deslizante, limite de concorrência, espaçamento entre disparos e lógica de retry para 429. O uso de tokens é rastreado para inferência de TPM. O estado persiste em SQLite entre reinicializações.

```
OpenCode ──▶ oc-proxy (localhost) ──▶ NVIDIA NIM (integrate.api.nvidia.com/v1)
```

## Pré-requisitos

- Node.js >= 18
- Uma chave de API NVIDIA NIM armazenada no arquivo de autenticação do OpenCode (`~/.local/share/opencode/auth.json`)
- Ferramentas de build do sistema para o addon nativo `better-sqlite3` (Python, compilador C++)

## Instalação

```bash
npm install
```

## Uso

```bash
node proxy.mjs              # porta padrão 4000
PORT=8765 node proxy.mjs    # porta personalizada
```

## Configuração

Toda configuração é feita via variáveis de ambiente:

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `4000` | Porta local de escuta |
| `UPSTREAM` | `https://integrate.api.nvidia.com/v1` | URL base da API upstream |
| `PROVIDER` | `nvidia` | Nome da chave no auth.json |
| `AUTH_FILE` | `~/.local/share/opencode/auth.json` | Caminho para o arquivo de credenciais |
| `DB_PATH` | `./oc-proxy.db` | Caminho do arquivo do banco SQLite |
| `DB_RETENTION_DAYS` | `365` | Dias para reter histórico de requisições/eventos |
| `SNOWFLAKE_WORKER_ID` | `0` | ID único do worker (0-1023) para IDs Snowflake |
| `FLUSH_INTERVAL_MS` | `5000` | Intervalo de descarga do buffer write-behind |
| `FLUSH_BATCH_SIZE` | `100` | Tamanho do lote para descarga do buffer |
| `MAX_RPM` | `25` | Requisições por minuto alvo (NIM publica 40, mantemos conservador) |
| `MAX_TPM` | `350000` | Tokens por minuto alvo (limitador proativo, composto com RPM) |
| `COMPLETION_BUFFER` | `4096` | Overhead estimado de completion adicionado aos tokens de prompt para verificação TPM |
| `COOLDOWN_MINUTES` | `60` | Minutos de espera após exaustão de retries 429 |
| `MAX_CONCURRENCY` | `2` | Máximo de requisições upstream em andamento |
| `MAX_RETRIES` | `3` | Retries em 429 antes de entrar em cooldown |
| `RETRY_DELAYS` | `20,40,60` | Atrasos de retry separados por vírgula (em segundos) |
| `MIN_DISPATCH_GAP_MS` | auto | Calculado de `60000 / MAX_RPM` se não definido |

## Formato do Arquivo de Autenticação

O proxy lê a chave da API do arquivo de autenticação do OpenCode. A entrada deve corresponder à variável `PROVIDER`:

```json
{
  "nvidia": {
    "type": "api",
    "key": "nvapi-..."
  }
}
```

## Limitador de Taxa (Throttling)

Cinco camadas previnem violações de rate limit:

1. **Janela deslizante (baseada em disparos)** -- Rastreia quando as requisições saem do proxy (não quando completam). `MAX_RPM` requisições por janela de 60 segundos.

2. **Janela de tokens (TPM)** -- Rastreia uso real de tokens em janela deslizante de 60s. Antes do disparo, o custo estimado (prompt + `COMPLETION_BUFFER`) é verificado contra `MAX_TPM`. Ambas as portas RPM e TPM devem passar.

3. **Limite de concorrência** -- Máximo de `MAX_CONCURRENCY` requisições upstream em andamento.

4. **Espaçamento entre disparos** -- Mínimo de `MIN_DISPATCH_GAP_MS` entre disparos (~2.4s a 25 RPM).

5. **Retry 429 + cooldown + limite adaptativo** -- Faz retry até `MAX_RETRIES` com backoff exponencial. Se todos falharem, pausa por `COOLDOWN_MINUTES` e decrementa o limite de taxa em 1 (mínimo de 5).

## Rastreamento de Uso de Tokens

O uso de tokens de toda requisição é interceptado e registrado:

- **SSE streaming**: `SSETapStream` transparente analisa eventos em trânsito sem buffering. Conta tokens de `delta.content` e `delta.reasoning_content`. Também analisa as linhas de comentário `:` da NIM para `input_tokens`/`output_tokens` exatos.
- **Respostas não-SSE**: extrai o campo `usage` da NIM diretamente. Fallback para `js-tiktoken` (também verifica `reasoning_content` para modelos de pensamento).
- **Detecção SSE**: lê o header `content-type` da resposta (não o `Accept` da requisição) para lidar corretamente com respostas stream da NIM.
- **Estimativa**: usa `js-tiktoken` com codificação `cl100k_base` quando a NIM não fornece dados de uso.

O uso é persistido em SQLite (tabela `requests`) via buffer write-behind e registrado no nível `info`.

## Injeção de Modelo

Configurável via array `thinkingModels` em `src/config.js`. Adicione novos modelos com uma regra:

```js
thinkingModels: [
  {
    pattern: /^z-ai\/glm-?5\.?1/i,
    injection: { chat_template_kwargs: { enable_thinking: true } },
  },
  {
    pattern: /^minimaxai\/minimax-m3$/i,
    injection: { chat_template_kwargs: { enable_thinking: true } },
  },
],
```

## Arquitetura

Consulte [ARCHITECTURE.pt-BR.md](ARCHITECTURE.pt-BR.md) para documentação detalhada do projeto.

## Testes

```bash
yarn test        # executar todos os testes
yarn test:watch  # modo watch
```

## Licença

[MIT](LICENSE)
