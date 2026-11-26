# Como funciona uma figurinha com som

Notas técnicas obtidas de figurinhas com som reais e do código do WhatsApp Web (novembro de 2026). O WhatsApp pode mudar qualquer um desses detalhes.

## 1. Dois arquivos em uma única mensagem

Uma figurinha com som são **dois arquivos separados** dentro da mesma mensagem:

1. a figurinha `.webp` (estática ou animada), que é enviada como `sticker`;
2. um áudio Ogg/Opus (ou M4A), que é enviado como `audio`, igual a uma mensagem de voz.

O `.webp` **não contém o áudio**. Ele só leva no seu EXIF a chave `"sound-sha256"`: o SHA-256, em base64, do áudio sem criptografia. O vínculo real entre os dois arquivos está na mensagem.

## 2. Estrutura da mensagem (protobuf)

```
Message {
  audioStickerMessage (134): FutureProofMessage {
    message (1): Message {
      stickerMessage (26): StickerMessage {
        url, fileSha256, fileEncSha256, mediaKey, mimetype = "image/webp",
        height, width, directPath, fileLength, mediaKeyTimestamp, isAnimated, emojis, …
        audioMessage (26): AudioMessage {            // oneof "audio"
          url, directPath, mediaKey, mediaKeyTimestamp,
          fileSha256, fileEncSha256, fileLength,
          seconds, mimetype = "audio/ogg; codecs=opus"
        }
      }
    }
  }
}
```

- O WhatsApp Web monta `{stickerMessage: {…, audioMessage}}` e o envolve em `audioStickerMessage` somente se houver áudio.
- É enviado com `<message type="media">` e `<enc mediatype="sticker">`.
- Ao receber, o áudio é descartado se `mediaKey`, `fileSha256` ou `fileEncSha256` não tiverem 32 bytes, se faltar `directPath`/`url` ou se o `mimetype` não for válido.

## 3. O áudio

| Aspecto | Valor |
|---|---|
| Formatos aceitos | `audio/ogg; codecs=opus`, `audio/mp4`, `audio/m4a`, `audio/x-m4a` |
| Tamanho máximo | 1.000.000 bytes (o WhatsApp Web não reproduz clipes maiores) |
| Tipo de envio | `audio` (chaves "WhatsApp Audio Keys") |
| Formato habitual | Opus mono, 48 kHz, ~32 kbps |

## 4. A figurinha

- WebP animado. O EXIF tem um bloco TIFF big-endian com a tag `0x5741` ("WA"), que contém um JSON com:
  - `sticker-pack-id`
  - `sticker-pack-name` (pacote)
  - `sticker-pack-publisher` (autor)
  - `emojis`
  - `sound-sha256`
- O servidor do WhatsApp rejeita figurinhas com mais de ~1 MB (HTTP 413).
- O guia oficial de pacotes de figurinhas exige que cada quadro dure pelo menos 8 ms.
- **Duração:** o WhatsApp não exige que o áudio e a animação durem o mesmo tempo; não verifica isso nem ao enviar nem ao receber. Ao tocar na figurinha, o WhatsApp Web reproduz a animação uma vez e o áudio uma vez, cada um por conta própria. Nas figurinhas reais observadas, ambos duram o mesmo tempo. Com durações diferentes, no teste feito no celular o WhatsApp repetiu o áudio em loop; não há como controlar isso pela figurinha.
- Todas as figurinhas com som reais observadas são animadas. Uma figurinha fixa com som é válida para o protocolo, mas não está comprovado que os clientes a reproduzam.

## 5. Opções da conta

O WhatsApp ativa o recurso por conta, com estas opções (AB props):

- `sound_stickers_consumption_enabled`
- `sound_stickers_creation_enabled`
- `sound_stickers_audio_playing_enabled`

Se a criação não estiver ativa, o WhatsApp Web descarta o áudio ao enviar. A extensão ativa as três **somente no seu navegador**.

## 6. O que a extensão faz

0. **Fontes:** a imagem pode ser um vídeo (`<video>`), um GIF, um WebP animado ou um APNG (`ImageDecoder` do WebCodecs) ou uma imagem fixa. O áudio pode vir do próprio vídeo ou de outro arquivo de áudio ou vídeo, com seu próprio trecho.
   - Por padrão, a animação e o áudio mantêm cada um a sua duração. Opcionalmente, se a animação durar menos que o áudio, ela se repete ou fica parada no último quadro (e se durar mais, é cortada no tamanho do áudio).
   - A análise depende apenas da animação: o áudio é enviado como arquivo à parte e não soma ao tamanho da figurinha. Por isso, mudar o trecho de áudio não obriga a recalcular, exceto quando a animação é ajustada à duração do áudio.
   - Uma imagem fixa é enviada como um WebP animado de um único quadro que dura o mesmo tempo que o áudio (ou, como teste, como WebP fixo).
   - Ao cortar um áudio à parte, aplica-se um fade de 8 ms nas bordas para evitar estalos.
1. **Corte:** o visualizador conta o tempo a partir do primeiro quadro real. Alguns vídeos cortados têm marcas de tempo que começam, por exemplo, em 130 s.
2. **Análise** (`analyze`):
   - Captura o trecho uma vez, quadro a quadro, pegando cada quadro no meio do seu intervalo. Se for pego exatamente na borda, o navegador às vezes devolve o quadro anterior.
   - Guarda uma impressão digital de 32×32 de cada quadro para detectar repetidos.
   - Codifica uma amostra de quadros em cada resolução e estima o tamanho de cada combinação de resolução e fps. As estimativas costumam acertar com ±5 %.
3. **Criação** (`create`):
   - O áudio é decodificado com WebAudio, convertido para mono a 48 kHz, codificado em Opus com WebCodecs e empacotado em Ogg.
   - Os quadros são codificados em WebP com o canvas do navegador e o WebP animado é montado. Os quadros repetidos são fundidos.
   - Se a figurinha passar de 1 MB, a qualidade é reduzida.
4. **Envio:** usa os módulos internos do WhatsApp Web para enviar o áudio (`encryptAndUpload`) e enviar a figurinha (`MediaPrep.sendToChat` com `stickerAudio`). Opcionalmente, abre a caixa de diálogo nativa de **Encaminhar**.
