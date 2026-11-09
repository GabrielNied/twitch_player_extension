# Alternate Player for Twitch

Quando você abre uma live na Twitch, a extensão redireciona a aba para um player
próprio (hls.js) que filtra os anúncios inseridos no stream.

## Como funciona

1. `twitch.js` (content script) avisa o `background.js` a cada navegação no twitch.tv.
2. Se a URL é de um canal (`twitch.tv/<canal>`) e ele está **ao vivo**, a aba vai para `player.html?channel=<canal>`.
3. `player.js` pega o token de reprodução (GQL), carrega a playlist do usher e toca com hls.js.
4. `ads.js` intercepta cada atualização da playlist e entrega ao hls.js uma playlist própria por qualidade, montada só com segmentos de conteúdo e ordenada pelo horário da transmissão (`EXT-X-PROGRAM-DATE-TIME`), com numeração que só cresce:
   - sem anúncio → os segmentos do stream principal;
   - com anúncio → os mesmos momentos tirados de um **stream reserva** com outro tipo de player (`popout`, `autoplay`, `embed`, `picture-by-picture`), que normalmente vem sem anúncio;
   - trecho que nenhum stream tem → é pulado (a imagem pausa e continua do ponto seguinte).
   Como a linha do tempo é a da transmissão, trocar de stream não faz o player voltar no tempo. As sessões reserva são abertas logo no início e mantidas, para já terem passado do próprio pre-roll quando um anúncio aparecer.

## Instalar (Vivaldi / Chrome / Edge / Brave)

1. Baixe o `.zip` mais recente em [Releases](https://github.com/GabrielNied/twitch_player_extension/releases/latest) e extraia em uma pasta fixa (não apague a pasta depois).
2. Abra `chrome://extensions` (ou `vivaldi://extensions`, `edge://extensions`, `brave://extensions`).
3. Ative o **Modo do desenvolvedor**.
4. **Carregar sem compactação** → selecione a pasta extraída (a que contém o `manifest.json`).

Para atualizar: baixe o zip novo, extraia por cima da mesma pasta e clique em recarregar na página de extensões.

## Uso

- Entrar numa live redireciona automaticamente.
- **Abrir no player da Twitch** (menu da engrenagem) volta pro player oficial e não redireciona de novo esse canal até fechar o navegador.
- Botão da extensão na barra: abre um menu com o canal da aba atual (abrir no player alternativo, ou voltar pro player da Twitch se já estiver nele) e as opções de redirecionamento automático, segundo plano e baixa latência.
- **Voltar no tempo**: a barra acima dos controles permite voltar até ~2 minutos; `AO VIVO` volta pra ponta.
- **Salvar replay**: salva os últimos 30 s, 1 min ou 2 min em `.mp4` na pasta de downloads (qualidade original, sem reprocessar).
- **Gravar**: grava do momento em que você clica até clicar de novo e salva em `.mp4`. Se a qualidade mudar no meio, sai em partes (`_parte1`, `_parte2`).
- Interface mínima: nome do canal, título e controles só aparecem com o mouse sobre o vídeo e somem sozinhos.
- **Tamanho do chat**: arraste a borda esquerda do chat para aumentar ou diminuir (duplo clique volta ao padrão). O tamanho fica salvo.
- **Segundo plano**: com "Continuar em segundo plano" ligado (padrão), a live segue tocando com a aba escondida e, depois de 10 s, cai para a menor qualidade com vídeo; ao voltar, a qualidade escolhida retorna. Desligado, o player para ao esconder a aba e reconecta no ao vivo ao voltar. Picture-in-picture e gravação em andamento nunca são afetados.
- **Atraso**: por padrão a live fica ~10 s atrás do ao vivo, folga que segura as esperas durante anúncios. Com **Baixa latência** (desligada por padrão), ~4 s, com mais travadas nos anúncios. Depois de uma travada ou de um anúncio pulado a velocidade muda um pouco (0,9x a 1,15x) até voltar ao atraso alvo.
- Engrenagem: qualidade, baixa latência, segundo plano, redirecionamento automático, estatísticas de vídeo, picture-in-picture, "Abrir no player da Twitch" e **Baixar log de diagnóstico**.
- Atalhos: `espaço`/`k` play, `m` mudo, `↑`/`↓` volume, `←`/`→` voltar/avançar 10 s, `l` ao vivo, `r` replay, `g` gravar, `f` tela cheia, `i` picture-in-picture, `c` chat, `Shift+D` log de diagnóstico.

## Anúncios

A Twitch insere os anúncios na própria playlist da live. O player monta sua própria playlist a partir da live, e onde ela tem anúncio usa o mesmo trecho de uma stream reserva (outro tipo de player da Twitch, que costuma vir sem anúncio). Quando nenhuma stream tem o trecho sem anúncio, o player espera e, quando o anúncio acaba, pula o trecho que faltou. Na entrada e na saída do anúncio pode pular ou repetir até ~1 s.

Durante um anúncio as streams reservas também recebem anúncio e são trocadas por novas. Para não fazer pedidos demais à Twitch, os pedidos de stream reserva têm um limite compartilhado entre todas as abas (~10 por minuto), com prioridade para a aba visível; uma aba em segundo plano pode ficar parada até o anúncio acabar.

## Diagnóstico

O player guarda um log dos eventos (playlists, trocas de stream, travadas, erros). **Baixar log de diagnóstico** na engrenagem (ou `Shift+D`) salva o arquivo `.ndjson` nos downloads. Para acompanhar ao vivo, rode `node tools/log-server.mjs`: enquanto ele estiver aberto, o player envia o log para `logs/`.

## Arquivos

| Arquivo | Função |
|---|---|
| `manifest.json` | Manifest V3 |
| `background.js` | Redirecionamento, regras de cabeçalho (DNR), limite de streams reservas |
| `popup.html/.css/.js` | Menu do botão da extensão na barra |
| `twitch.js` | Content script no twitch.tv |
| `api.js` | GQL, token de reprodução, usher, parser da playlist master |
| `ads.js` | Detecção/filtro de anúncios e stream reserva |
| `realign.js` | Corrige o alinhamento do hls.js na troca de qualidade |
| `debuglog.js` | Log de diagnóstico |
| `tools/log-server.mjs` | Recebe o log ao vivo em `logs/` |
| `player.html/.css/.js` | Página do player |
| `replay.js` | Buffer de replay e gravação (segmentos → `.mp4`) |
| `settings.js` | Configurações em `chrome.storage.local` |
| `lib/hls.min.js` | hls.js 1.5.20 |

## TV Samsung (experimental)

A pasta [`tizen/`](tizen/) tem um app para TVs Samsung que reaproveita `api.js`, `ads.js`, `realign.js` e o hls.js da extensão. Instruções em [`tizen/README.md`](tizen/README.md).
