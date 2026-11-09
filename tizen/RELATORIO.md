# Alt Player TV (Samsung S90F): relatório técnico

2 de novembro de 2026

## 1. Contexto

A extensão de navegador (Alternate Player for Twitch) toca lives da Twitch com hls.js e um filtro que
troca os segmentos de anúncio por segmentos de streams reserva (`ads.js`). O objetivo foi levar isso
para a TV Samsung **QN55S90FAGXZD (S90F, OLED, 2025)** como app Tizen, com interface para controle
remoto no estilo do S0undTV.

Dados da TV (lidos pelo depurador remoto):

| Item | Valor |
|---|---|
| Sistema | Tizen 9.0 |
| Motor web | Chromium 120.0.6099.5 (`SMART-TV; LINUX; Tizen 9.0`) |
| Viewport do app | 1920×1080, devicePixelRatio 1 |
| Samsung Product API | `webapis` global já disponível (sem incluir `webapis.js`); AppCommon versão 3.9 |
| Renderização do vídeo | `MediaPlayerRenderer` (player da plataforma / plano de vídeo de hardware) |

## 2. O que foi construído

Tudo na pasta `tizen/` do repositório da extensão. Nada foi commitado ainda.

- **Build**: esbuild junta `tizen/src/*.js` com `../api.js` e `../ads.js` da extensão num único script
  clássico (`app/main.js`, alvo `chrome69`). `lib/hls.min.js` (1.5.20) e o ícone são copiados.
  Única mudança na extensão: `api.js` passou a exportar `gql`.
- **Módulos** (`tizen/src/`):
  - `main.js`: teclas do controle e roteamento entre telas.
  - `nav.js`: navegação espacial pelo D-pad, com grupos e travas.
  - `home.js`: menu lateral, seções, busca e configurações.
  - `player.js`: hls.js + AdFilter, painel de informações, fileira de canais e menu de qualidade.
  - `chat.js`: IRC anônimo por WebSocket, histórico via recent-messages.robotty.de, badges, emotes da Twitch, 7TV, BTTV e FFZ.
  - `emotes.js`, `twitch.js` (consultas GQL), `auth.js` (login por device code, Helix), `login.js` (QR code), `store.js` (localStorage), `ui.js`.
- **Funcionalidades**:
  - Seções: Seguindo (canais seguidos + favoritos), Em alta (filtro PT/todos), Categorias e busca.
  - Player: chat sobre o vídeo ou ao lado, à esquerda ou à direita; painel com informações e ações; fileira de canais ao vivo; CH+/CH−.
  - Configurações e login da Twitch (Client ID próprio, tipo Public, escopo `user:read:follows`).
- **Rede fora da extensão** (sem poder trocar `Origin`), testado com curl:

| Requisição | Origin `null`/`file://` | Origin `http://localhost` |
|---|---|---|
| gql.twitch.tv | ok, CORS `*` | ok, CORS `*` |
| usher.ttvnw.net (master) | 200, sem cabeçalho CORS | 200, sem cabeçalho CORS |
| *.playlist.ttvnw.net (qualidade) | **403** | ok |
| segmentos | ok, CORS `*` | ok |

  Na TV, o app empacotado com `<access origin="*">` funcionou em todas as etapas.

## 3. Ambiente e ferramentas

- **Tizen Studio 6.1 (CLI)** em `C:\Users\gabri\OneDrive\Documents\Nied\tizen-studio`, mais as
  extensões `Certificate-Manager`, `cert-add-on` e `TV-SAMSUNG-Extension-Tools`.
- **Developer Mode** ligado na TV, com o IP do PC. Foi preciso reiniciar a TV segurando o botão de
  ligar para a porta 26101 abrir.
- **Certificado Samsung**: perfil `altplayer`, distribuidor com o DUID real da TV (obtido por
  `sdb shell 0 getduid`; o `uuid:` da API de rede da TV **não** é o DUID).
- **Pacote**: o nome do `.wgt` não pode ter espaço (a instalação falha sem mensagem). Por isso o
  `<name>` ficou `AltPlayer`.
- **Depuração remota** (fundamental para a investigação):
  1. `sdb -s <ip>:26101 shell 0 debug AltPlayTV1.AltPlayer` → `... with debug 1 port: NNNNN`
  2. `sdb -s <ip>:26101 forward tcp:NNNNN tcp:NNNNN`
  3. `http://127.0.0.1:NNNNN/json` dá o `webSocketDebuggerUrl` (Chrome DevTools Protocol).

     Com ele é possível rodar JS, ler o console, injetar teclas (`Input.dispatchKeyEvent`), ver
     métricas e o domínio `Media`.

## 4. O problema: proteção de tela durante a live

**Sintoma**: com o chat **ao lado do vídeo** (o vídeo encolhe para 1500×1080 e o chat ocupa
420 px), depois de **exatamente 2 minutos sem apertar nenhuma tecla** a TV mostra a proteção de
tela da Samsung (fundo preto com pontos coloridos). É a mesma que aparece com a TV parada num menu,
como se nenhum vídeo estivesse tocando. A live continua tocando por baixo.

O que o app percebe quando a proteção aparece:

- evento `blur` na janela e `document.hasFocus()` passa a `false`;
- `document.hidden` continua `false`;
- `webapis.appcommon.getAppState()` continua `"FOREGROUND"`;
- o vídeo continua tocando (`currentTime` avança, `readyState` 4).

O app **não consegue** tirar a proteção sozinho: `webapis.appcommon.setAppFocus(true)` não tem
efeito.

## 5. Investigação (com dados medidos)

1. **Desempenho com o chat ligado** (150 s, chat ao lado, canal com ~7 mil espectadores): heap JS de
   4 a 8 MB, thread principal 4 a 6% ocupada, layout+style ~0%, cerca de 2 mil nós no DOM, nenhum
   erro. Não é sobrecarga.
2. **Vídeo ao alternar o chat**: o JS mostra o vídeo tocando normalmente antes e depois, sem
   `waiting`, `stalled` ou `error`.
3. **Pipeline de mídia** (domínio `Media` do CDP): `kRendererName=MediaPlayerRenderer` com o chat
   desligado, sobre o vídeo e ao lado. O motor usa o mesmo caminho de hardware nos três casos.
4. **API de proteção de tela**:
   `webapis.appcommon.setScreenSaver(AppCommonScreenSaverState.SCREEN_SAVER_OFF)` devolve o
   callback de sucesso (o console mostra `[AppCommon] setScreenSaver successCallback`).
5. **Teste com horário** (chat ao lado, sem tocar no controle):
   - última tecla às **18:22:36**;
   - o app reenviava `SCREEN_SAVER_OFF` a cada 20 s, 6 vezes no intervalo;
   - proteção (`blur`) às **18:24:36**, 2:00 depois.
6. **Chat sobre o vídeo** (vídeo 1920×1080 com o chat por cima, semitransparente): de **18:29:23**
   (tecla que tirou a proteção) até **18:33:51**, foram **4 min 28 s** sem tecla e **sem proteção**.
7. **Truque do espaçamento**: o elemento `<video>` ficou com 1920×1080 e `padding-right: 420px`, então
   a imagem foi desenhada nos 1500 px restantes. A última tecla foi às 18:34:48 (chat desligado e
   religado) e a proteção veio às **18:36:48**. Não ajuda: a TV olha o tamanho real da imagem, não a
   caixa do elemento.
8. **Outras APIs**:
   - `webapis.systemcontrol.captureScreen()` dá `NotSupportedError` (é de signage);
   - `tizen.power` não existe na TV;
   - `webapis.tvinfo` só expõe chaves de legenda e acessibilidade.
9. **Achado à parte, já corrigido**: a TV ficava em **852×480** (`videoWidth`) mesmo com o hls.js já
   carregando 1080p60. A resolução não muda quando o hls.js sobe de qualidade depois de começar.
   Correção: na qualidade automática, `hls.startLevel` começa no nível máximo. Conferido 1920 desde o
   início.

## 6. Tentativas que não resolveram

| Tentativa | Resultado | Situação no código |
|---|---|---|
| `setScreenSaver(OFF)` no `playing`, `ON` no `pause`/parada | Sucesso na chamada, a proteção aparece igual | **Mantido** (orientação da Samsung para apps de vídeo) |
| Reenviar `OFF` a cada 20 s | Proteção aos 2:00 do mesmo jeito | Removido |
| Reanexar a mídia (`hls.detachMedia/attachMedia`) ao mudar o layout do chat | Toca normal, proteção continua | Removido |
| `<video>` em tela cheia com `padding` para o chat | Proteção aos 2:00 | Removido |
| `webapis.appcommon.setAppFocus(true)` com a proteção na tela | Não tira a proteção | Não usado |

## Solução adotada (2/11, 19:27)

Testes via CDP, cada um contado a partir da última tecla real:

| Teste | Resultado |
|---|---|
| `webapis.appcommon.setAuxHint(...)` | `SecurityError: Permission denied` (exige privilégio de plataforma) |
| `requestFullscreen()` no container do player | Proteção aos 121 s |
| Chat de 340 px (vídeo de 1580 px) | Proteção aos 120 s |
| Vídeo em tela cheia por 100 ms aos 100 s | Proteção aos 221 s: o pulso **zera** o contador |
| `webapis.appcommon.generateKey('ArrowRight')` a cada 60 s | **Sem proteção** por 3 min 8 s |

`generateKey` aceita nomes de tecla do navegador (`'ArrowRight'` vira keyCode 114 para o sistema)
e a TV conta a tecla como uso do controle.

No app (`player.js`, `keepAwake()`): com a live tocando, o chat ligado e **ao lado do vídeo**, e
nenhum painel aberto, se passar 90 s sem tecla o app gera um `ArrowRight`. A tecla gerada é ignorada
pelo próprio app.

Verificado na TV: última tecla às 19:22:59, teclas geradas às 19:24:30 e 19:26:10, e **nenhuma
proteção em 300 s**.

## 7. Conclusão (antes da solução)

- A S90F só segura a proteção de tela quando a **imagem do vídeo ocupa a tela inteira**. Com a
  imagem menor (chat ao lado), ela trata o app como "sem vídeo" e liga a proteção após 2 min sem
  tecla.
- Nesse caso a TV **ignora** `setScreenSaver(OFF)`. Pode ser bug ou política do firmware: um tópico
  no fórum da Samsung ("Screen Saver Appcommon API doesn't work") relatava o mesmo, mas hoje dá 404.
- **Funciona hoje**: chat **sobre o vídeo** (dá para estreitar e deixar o fundo transparente nas
  Configurações) ou chat desligado.

Em aberto:

- Existe um limite? Por exemplo, a partir de quantos % da tela a imagem conta como "tela cheia".
  Não foi testado com o chat estreito (340 px).
- Uma passagem rápida para tela cheia zera o contador de 2 min? Não foi testado.
- O ajuste "Tempo de proteção automática" da TV controla essa proteção de 2 min? A documentação diz
  que, com ele desligado, a API de proteção de tela não tem efeito.

## 8. Ideias para pesquisar

1. **Código do motor web da Samsung**: a Samsung publica o código aberto do motor web dos TVs
   (Chromium-efl / "TizenTV") em opensource.samsung.com. Procurar onde o motor chama a proteção de
   tela / `screensaver` / `PowerSaveBlocker` e qual condição de tamanho ou tela cheia ele usa.
2. **`webapis.appcommon.setAuxHint`**: existe na TV, mas não tem documentação. No Tizen, "aux hints"
   são dicas para o gerenciador de janelas; pode haver uma relacionada à proteção de tela.
3. **Outros apps Tizen de vídeo com layout lado a lado ou mini player** (TizenTube/TizenBrew,
   clientes de Twitch antigos): ver como evitam a proteção.
4. **Limite de tamanho**: testar chat de 340 px e outros tamanhos de imagem. Basta 2,5 min sem tecla
   por teste; o evento `blur` mostra quando a proteção entra.
5. **Passagem rápida para tela cheia** antes de 2 min sem tecla: só vale se for imperceptível.
6. **Fullscreen API**: `requestFullscreen()` no container do player (não no `<video>`) e ver se a TV
   passa a considerar "vídeo em tela cheia" com a imagem menor.
7. **AVPlay** (player nativo da Samsung): segura a proteção sozinho, mas busca as playlists por conta
   própria. Perderia o filtro de anúncios, que reescreve as playlists em JS. O FAQ da Samsung diz que
   `<video>` e AVPlay não tocam ao mesmo tempo.
8. **Suporte da Samsung** (fórum de desenvolvedores ou chamado), com os dados da seção 5.

## 9. Referências

- Guia da proteção de tela (Samsung): <https://developer.samsung.com/tv/develop/guides/fundamentals/setting-screensaver>.
  Diz para desligar a proteção ao iniciar/retomar o vídeo e ligar ao pausar/parar, e que a API não
  tem efeito se "Auto Protection Time" estiver desligado.
- AppCommon API: <https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/appcommon-api.html>.
  `setScreenSaver(state, onsuccess?, onerror?)`, `SCREEN_SAVER_OFF = 0`, `SCREEN_SAVER_ON = 1`.
- Tópico do fórum (hoje 404): <https://forum.developer.samsung.com/t/screen-saver-appcommon-api-doesnt-work/24361>
- Métodos que a TV expõe em `webapis.appcommon` (lidos na própria TV): `getVersion`, `getUuid`,
  `generateKey`, `registerKey`, `registerKeyInSpecialMode`, `unregisterKey`,
  `getSpecialSupportedKeys`, `getSystemStat`, `getForegroundAppId`, `setEpopAppWindow`,
  `requestTvContextTask`, `setIMERecommendedWordsType`, `setIMERecommendedWords`, `setIMEPosition`,
  `setScreenSaver`, `resetProfiling`, `recordProfiling`, `setAppFocus`, `setWindowStackMode`,
  `setAuxHint`, `getAppState`.
- Como montar o ambiente, gerar o build e instalar: `tizen/README.md`.
