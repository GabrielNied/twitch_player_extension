# Alt Player para TV Samsung (Tizen)

App para TVs Samsung que usa o mesmo núcleo da extensão (`../api.js`, `../ads.js`, `../realign.js`,
`../lib/hls.min.js`): a live toca pelo hls.js com o filtro de anúncios, e a interface é feita
para o controle remoto.

## O que tem

- **Tela inicial** com menu lateral: Buscar, Seguindo, Em alta, Categorias e Configurações. O
  conteúdo da direita acompanha o item do menu em foco.
- **Seguindo**: canais seguidos ao vivo (com login da Twitch) e os favoritos da TV, ao vivo e
  offline. O número ao lado do menu é quantos estão ao vivo.
- **Em alta** e **Categorias**: lives mais vistas, filtráveis por português ou todos os idiomas.
- **Busca** de canais e categorias com o teclado da TV.
- **Player**:
  - chat sobre o vídeo ou ao lado dele, à direita ou à esquerda;
  - no chat: badges, emotes da Twitch, 7TV, BTTV e FFZ, e as mensagens de antes de você entrar
    (recent-messages.robotty.de);
  - painel com informações da live, ações (chat, qualidade, favoritar, recarregar) e uma fileira
    de canais ao vivo para trocar;
  - CH+/CH− trocam de canal direto.
- **Configurações**: idioma, qualidade inicial, baixa latência, chat (posição, largura, letra,
  fundo, emotes, histórico) e conta da Twitch.

## Controle

| Onde | Tecla | Faz |
|---|---|---|
| Tela inicial | setas / OK | navega / abre |
| Tela inicial | Voltar | volta para o menu; no menu, duas vezes sai do app |
| Player | OK ou ↑ | painel com informações e ações |
| Player | ↓ | painel com a fileira de canais ao vivo |
| Player | CH+ / CH− | canal anterior / próximo da fileira |
| Player | ⏯ | pausa e continua (volta para o ao vivo depois de pausa longa) |
| Player | Voltar | fecha o painel; sem painel, volta para a tela inicial |

## Login da Twitch (opcional)

Sem login, "Seguindo" mostra só os favoritos da TV (botão "☆ Favoritar" no player). Para ver
os canais seguidos da conta, o app precisa de um Client ID próprio:

1. Ative a verificação em duas etapas na conta da Twitch (exigência para registrar apps).
2. Em <https://dev.twitch.tv/console/apps>, clique em *Register Your Application*:
   - nome: qualquer um, por exemplo `alt-player-tv-<seu usuário>`;
   - OAuth Redirect URL: `http://localhost`, que não é usada;
   - categoria: *Application Integration*;
   - tipo de cliente: **Public**.
3. Copie o **Client ID** para `TWITCH_CLIENT_ID` em [src/config.js](src/config.js), gere o build e
   instale de novo.
4. Na TV: Configurações → Conta da Twitch → Entrar. Aparece um QR code e um código para
   digitar em twitch.tv/activate.

O login usa o *device code flow* com o escopo `user:read:follows` e só lê quem você segue.
Sem uso por 30 dias, a Twitch expira a sessão e é preciso entrar de novo.

## Build

```sh
cd tizen
npm install
npm run build      # gera app/main.js, app/lib/hls.min.js, app/icon.png
```

`app/` é o projeto Tizen (tem o `config.xml`). Rode o build de novo sempre que mudar algo em
`src/`, `../api.js` ou `../ads.js`.

## Testar no PC

Fora da extensão não dá para trocar `Origin`/`Referer`. O usher só libera CORS para
`https://www.twitch.tv`, então o Chrome normal bloqueia. Na TV o app empacotado não tem esse
bloqueio. No PC, use um perfil separado com a segurança desligada:

```sh
npx --yes http-server app -p 8080 -c-1
"C:\Program Files\Google\Chrome\Application\chrome.exe" --disable-web-security --user-data-dir="%TEMP%\altplayer-chrome" http://localhost:8080
```

Setas, Enter e Esc fazem o papel do controle. `http://localhost:8080/?channel=<canal>` abre direto
no player.

## Instalar na TV

1. **Tizen Studio (no PC)**: instalador CLI `web-cli_Tizen_Studio_6.1_windows-64.exe` de
   <https://download.tizen.org/sdk/Installer/tizen-studio_6.1/>, depois as extensões Samsung
   (o `package-manager-cli` pede administrador):

   ```sh
   web-cli_Tizen_Studio_6.1_windows-64.exe --accept-license <pasta>\tizen-studio
   <pasta>\tizen-studio\package-manager\package-manager-cli.exe install --accept-license Certificate-Manager cert-add-on TV-SAMSUNG-Extension-Tools
   ```

   Os comandos `tizen` e `sdb` ficam em `tizen-studio\tools\ide\bin` e `tizen-studio\tools`.
2. **Developer Mode na TV**: abra *Apps*, digite `1 2 3 4 5` no controle, ligue o
   *Developer mode*, coloque o IP do PC e reinicie a TV segurando o botão de ligar.
3. **Conectar**: `sdb connect <IP_DA_TV>`, depois `sdb devices` mostra a TV.
4. **Certificado**: abra `tizen-studio\tools\certificate-manager\CertificateManager.bat` →
   novo perfil **Samsung** → TV. Faça login com a conta Samsung e crie os certificados de autor e
   de distribuidor. Com a TV conectada, o DUID dela já vem preenchido (`sdb shell 0 getduid`
   confere). Nome do perfil, por exemplo, `altplayer`.
5. **Empacotar e instalar**:

   ```sh
   tizen package -t wgt -s altplayer -o dist -- app
   tizen install -n AltPlayer.wgt -s <IP_DA_TV>:26101 -- dist
   tizen run -p AltPlayTV1.AltPlayer -s <IP_DA_TV>:26101
   ```

   Depois disso ele aparece na lista de apps da TV.
