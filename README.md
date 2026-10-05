# Multi-Character Single Reply (v2)

Extensão para o SillyTavern que faz o modelo escrever **todos os personagens da cena numa única mensagem**, e que te ajuda a montar a cena com um pequeno assistente.

## Instalação

1. Copia a pasta `multi-char-single-reply` para:
   - `SillyTavern/public/scripts/extensions/third-party/`
   - (versões recentes também aceitam `SillyTavern/data/<utilizador>/extensions/`)
2. Reinicia o SillyTavern e recarrega a página (Ctrl+F5).
3. Abre **Extensions** e procura **Multi-Character Single Reply**.

## Como usar

1. Abre um chat com o personagem principal.
2. **Personagens na cena:** marca os extras (o atual entra automaticamente).
3. **Contexto da cena:** escreve onde estão, o que se passa, relações conhecidas.
4. **Gerar perguntas:** o modelo faz algumas perguntas pertinentes com base nos cartões e no teu contexto.
5. Responde às perguntas (podes deixar algumas em branco).
6. **Construir cena:** o modelo junta tudo num prompt de cena (cenário, relações, objetivos, tom).
7. Edita o texto à vontade. Fica guardado **por chat** e é injetado em cada resposta.
8. Ativa a extensão no topo do painel.

As descrições originais dos cartões **não são reescritas**: o modelo só gera a camada da cena, e os cartões são enviados à parte.

Usa **Ver prompt injetado** para confirmar exatamente o que é enviado.

## Notas

- Gerar perguntas e construir a cena gastam 1 chamada cada à API ligada.
- Se mudares os personagens da cena, usa Limpar cena e constrói de novo.
- Chats de grupo: o ST gera uma resposta por membro. Define *Group generation handling mode* → **Join character cards** e *Activation Strategy* → **Manual**, ou deixa só um membro ativo.
- Se o modelo ignorar a instrução, tenta profundidade 0 ou 1, ou o formato "Personalizado".
