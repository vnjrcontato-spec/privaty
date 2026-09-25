# STRIKEPOINT

FPS tático multiplayer para navegador. Este repositório entrega um MVP jogável em rede local: o servidor Node.js mantém uma única partida por instância e vários navegadores conectam à mesma sala pelo WebSocket.

## O que funciona neste MVP

- Cena FPS 3D própria, mapa Iron Yard e controle em primeira pessoa.
- Lobby compartilhado por todos os navegadores conectados ao mesmo servidor.
- Conexão manual por IP; o navegador não tenta fingir descoberta automática de servidores.
- Equipes Alpha e Bravo, seleção de equipe e início de partida pelo host.
- Movimento sincronizado, interpolação de jogadores remotos e predição simples do jogador local.
- Controlador de movimento validado também no servidor, com colisões contra o mapa.
- Rifle AR-12 e pistola V9, munição, recarga, disparos hitscan, dano corporal, headshots e eliminações.
- Rodadas de eliminação com cronômetro, placar, killfeed e reinício automático.
- Indicador de ping medido com ida e volta real pelo WebSocket.
- Servidor HTTP e WebSocket na mesma porta na versão de produção.

O MVP não inclui objetivo de bomba, economia, granadas, contas, ranking, inventário persistente, bots ou partidas públicas pela internet. O modo atual é eliminação por equipes. A lista automática de servidores também não está implementada; use o endereço IP do host.

## Requisitos

- Node.js 20.19 ou mais recente (Node 22+ recomendado).
- npm.
- Computadores conectados ao mesmo roteador para o modo LAN.
- Navegador desktop com WebGL e teclado/mouse.

## Instalação e desenvolvimento

Na pasta do projeto:

    npm install
    npm run dev

O terminal inicia dois serviços:

- Interface Vite: http://localhost:5173
- Servidor do jogo: ws://localhost:3000/game

O servidor aceita conexões de outros computadores (0.0.0.0). No PC que vai hospedar, descubra o IP local:

    hostname -I

Escolha o endereço IPv4 da rede, por exemplo 192.168.0.10.

### Testar em dois computadores

1. No PC host, execute npm run dev.
2. No navegador do host, abra http://localhost:5173.
3. Informe um callsign e clique HOST MATCH.
4. No segundo PC conectado ao mesmo roteador, abra http://192.168.0.10:5173, trocando o IP pelo endereço do host.
5. Clique JOIN SERVER. O campo de servidor deve mostrar 192.168.0.10:3000.
6. Quando os dois jogadores aparecerem no lobby, o host clica START MATCH.
7. Clique dentro do mapa para capturar o mouse e começar a jogar.

Se o segundo PC conseguir abrir a interface mas não conectar ao jogo, confira se a porta 3000 está liberada. Em modo de desenvolvimento, a porta 5173 também precisa estar acessível para carregar a interface.

Ubuntu com UFW:

    sudo ufw allow 3000/tcp
    sudo ufw allow 5173/tcp

Use a regra da porta 5173 apenas enquanto estiver usando o Vite. A porta 3000 serve a interface e o jogo quando o servidor de produção está iniciado.

## Executar como servidor de produção na LAN

    npm install
    npm run build
    npm start

Abra http://localhost:3000 no host. Os demais jogadores acessam http://IP-DO-HOST:3000. HTTP e WebSocket são servidos pelo mesmo processo e porta.

Para alterar a porta:

    PORT=3000 npm start

## Publicar na internet sem deixar seu PC ligado

O projeto está preparado para o Render como um Web Service, que mantém o servidor Node.js e aceita WebSocket. A pasta contém um arquivo render.yaml com a configuração de build e inicialização.

1. Crie um repositório no GitHub pelo navegador.
2. Extraia o ZIP e envie o conteúdo do projeto para a raiz desse repositório. Inclua render.yaml; não envie a pasta node_modules.
3. No Render, escolha New > Blueprint e conecte o repositório.
4. Confirme a configuração e crie/aplique o serviço.
5. Quando o deploy terminar, abra o endereço público terminado em onrender.com.

O Render entrega o site e o WebSocket pelo mesmo endereço. O cliente usa WSS automaticamente no endereço HTTPS público. Não é preciso informar uma segunda porta.

O plano gratuito é adequado para validar o deploy, mas pode suspender o serviço após 15 minutos sem tráfego e leva cerca de um minuto para acordar. Durante uma partida, os clientes enviam mensagens periódicas que mantêm a conexão ativa. Para manter o jogo sempre disponível, selecione um plano pago no Render; o plano Starter está listado a US$ 7 por mês na tabela consultada em setembro de 2026. Confira o valor atual antes de ativar.

Todos que entrarem pelo endereço público chegam à mesma sala deste servidor. A versão atual tem uma sala por processo e ainda não possui senha de lobby.

## Controles

| Tecla/ação | Função |
| --- | --- |
| W A S D | Mover |
| Shift | Correr |
| Ctrl | Agachar |
| Espaço | Pular |
| Mouse | Mirar |
| Segurar botão esquerdo | Atirar |
| R | Recarregar |
| 1 / 2 | Rifle / pistola |
| Segurar Tab | Placar |
| Esc | Liberar o mouse |

Depois de liberar o mouse com Esc, clique no mapa para capturá-lo novamente.

## Arquitetura

    client/src
      game/GameClient.ts   Cena Three.js, câmera, controles, armas e interpolação
      main.ts              Conexão, lobby, HUD, placar e mensagens de interface
      style.css            Menu, lobby e HUD responsivos

    server/src
      index.ts             HTTP, WebSocket, sala, estado da partida e simulação

    shared/src
      protocol.ts          Tipos e mensagens de rede compartilhados
      movement.ts          Movimento, colisões, limites e posições de spawn

O cliente envia entradas de movimento e comandos de ação. O servidor aplica o movimento em ticks de 20 Hz e decide munição, acertos, dano, eliminações, cronômetro e placar. Os snapshots incluem jogadores, equipes e estado da rodada. Jogadores remotos são interpolados entre atualizações; o jogador local usa predição básica com correção pelo estado autoritativo.

Mensagens principais:

- Cliente → servidor: join, input, shoot, reload, weapon, team, start, ping.
- Servidor → cliente: welcome, state, event, error, pong.

O protocolo tem versão SP-1; cliente e servidor com versões diferentes não entram na partida.

## Verificações

    npm run check
    npm run build

/health confirma que o servidor HTTP está ativo e /api/status retorna o estado atual da sala.

## Limites desta versão

- Uma sala por processo de servidor; o navegador não cria outro processo de servidor.
- Conexões diretas dentro da LAN. Para jogadores fora da rede, será necessário publicar um servidor e configurar acesso externo.
- Sem descoberta automática, autenticação, lista pública ou senha de sala.
- Hit detection simplificada para o MVP; não há lag compensation nem anti-cheat avançado.
- Modelos, sons e mapa são provisórios e gerados pelo próprio jogo, sem assets de Counter-Strike.
