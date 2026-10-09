# Alternate Player for Twitch

Quando você abre uma live na Twitch, a extensão redireciona a aba para um player
próprio (hls.js) que filtra os anúncios inseridos no stream.

## Como funciona

1. `twitch.js` (content script) avisa o `background.js` a cada navegação no twitch.tv.
2. Se a URL é de um canal (`twitch.tv/<canal>`) e ele está **ao vivo**, a aba vai para `player.html?channel=<canal>`.
3. `player.js` pega o token de reprodução (GQL), carrega a playlist do usher e toca com hls.js.
4. `ads.js` intercepta cada atualização da playlist:
   - sem anúncio → passa direto;
   - com anúncio → busca um **stream reserva** com outro tipo de player (`popout`, `autoplay`, `embed`, `picture-by-picture`) que normalmente vem sem anúncio, e toca ele durante o intervalo;
   - se nenhum reserva estiver limpo → remove os segmentos de anúncio (a imagem pausa e volta no ao vivo quando o intervalo acaba).

## Instalar (Vivaldi / Chrome / Edge / Brave)

1. Abra `vivaldi://extensions` (ou `chrome://extensions`).
2. Ative o **Modo do desenvolvedor**.
3. Remova a versão antiga quebrada (0.4.2), se ainda aparecer.
4. **Carregar sem compactação** → selecione esta pasta (`alternate-player-twitch`).

Dica: se colocar a pasta exatamente em
`Downloads\alternate-player-twitch-mvp\alternate-player-twitch`, o ID da extensão
volta a ser o mesmo de antes e o volume salvo é reaproveitado.

## Uso

- Entrar numa live redireciona automaticamente.
- **Abrir no player da Twitch** (menu da engrenagem) volta pro player oficial e não redireciona de novo esse canal até fechar o navegador.
- Botão da extensão na barra: num canal, abre no player alternativo; fora da Twitch, liga/desliga o redirecionamento (aparece `OFF` no ícone).
- **Voltar no tempo**: a barra acima dos controles permite voltar até ~2 minutos; `AO VIVO` volta pra ponta.
- **Salvar replay**: salva os últimos 30 s, 1 min ou 2 min em `.mp4` na pasta de downloads (qualidade original, sem reprocessar).
- **Gravar**: grava do momento em que você clica até clicar de novo e salva em `.mp4`. Se a qualidade mudar no meio, sai em partes (`_parte1`, `_parte2`).
- Interface mínima: nome do canal, título e controles só aparecem com o mouse sobre o vídeo e somem sozinhos.
- **Tamanho do chat**: arraste a borda esquerda do chat para aumentar ou diminuir (duplo clique volta ao padrão). O tamanho fica salvo.
- Engrenagem: qualidade, baixa latência, redirecionamento automático, estatísticas de vídeo, picture-in-picture e "Abrir no player da Twitch".
- Atalhos: `espaço`/`k` play, `m` mudo, `↑`/`↓` volume, `←`/`→` voltar/avançar 10 s, `l` ao vivo, `r` replay, `g` gravar, `f` tela cheia, `i` picture-in-picture, `c` chat.

## Arquivos

| Arquivo | Função |
|---|---|
| `manifest.json` | Manifest V3 |
| `background.js` | Redirecionamento, botão da barra, regras de cabeçalho (DNR) |
| `twitch.js` | Content script no twitch.tv |
| `api.js` | GQL, token de reprodução, usher, parser da playlist master |
| `ads.js` | Detecção/filtro de anúncios e stream reserva |
| `player.html/.css/.js` | Página do player |
| `replay.js` | Buffer de replay e gravação (segmentos → `.mp4`) |
| `settings.js` | Configurações em `chrome.storage.local` |
| `lib/hls.min.js` | hls.js 1.5.20 |
