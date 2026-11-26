# Ferramentas de desenvolvimento

Páginas para testar a extensão sem o WhatsApp. Sirva-as a partir da raiz do repositório com um servidor local:

```sh
python3 -m http.server 8765
```

- `http://127.0.0.1:8765/dev/harness.html`: expõe `testConvert(url, opcoes)` e `testEstimate(url, opcoes)`. Convertem um vídeo (por exemplo, um servido de uma pasta local) e comparam o tamanho estimado com o real.
- `http://127.0.0.1:8765/dev/ui-test.html`: monta o painel com Trusted Types obrigatório, como no WhatsApp Web. Abra-o com `window.postMessage({ __waas: "togglePanel" }, location.origin)`.
- `calibracao/calibracao_defasagem.mp4`: contador de milissegundos com um apito em cada "0". Serve para medir a defasagem entre áudio e imagem de uma figurinha em um celular. É gerado com `gerar_calibracao.py`.
