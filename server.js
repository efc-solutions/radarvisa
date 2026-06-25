const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT  = process.env.PORT || 8080;
const CHAVE = (process.env.ANTHROPIC_API_KEY || "").trim();

// ── Variáveis Google Sheets (configurar no Render) ────────────
// GOOGLE_SHEET_ID        → ID da planilha (entre /d/ e /edit na URL)
// GOOGLE_SERVICE_ACCOUNT → conteúdo completo do arquivo JSON baixado do Google Cloud
// ─────────────────────────────────────────────────────────────

function servArquivo(res, filePath) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end("404"); return; }
  const tipos = { ".html":"text/html;charset=utf-8", ".js":"application/javascript", ".json":"application/json", ".css":"text/css" };
  res.writeHead(200, { "Content-Type": tipos[path.extname(filePath)] || "text/plain" });
  fs.createReadStream(filePath).pipe(res);
}

// ── Busca o DOU ───────────────────────────────────────────────
function buscarDOU(dataAPI, callback) {
  var opts = {
    hostname: "www.in.gov.br",
    path: "/leiturajornal?data=" + dataAPI + "&secao=do1",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "pt-BR,pt;q=0.9",
      "Cache-Control": "no-cache"
    }
  };

  var req = https.request(opts, function(res) {
    var chunks = [];
    res.on("data", function(c) { chunks.push(c); });
    res.on("end", function() {
      var html = Buffer.concat(chunks).toString("utf8");
      console.log("DOU status:", res.statusCode, "tamanho:", html.length);
      callback(null, html, res.statusCode);
    });
  });

  req.on("error", function(e) { callback(e, null, 0); });
  req.setTimeout(20000, function() { req.destroy(); callback(new Error("Timeout"), null, 0); });
  req.end();
}

// ── Extrai publicações ANVISA/HPPC do HTML ────────────────────
function extrairPublicacoes(html, dataExib) {
  if (!html || html.length < 500) return [];

  var resultados = [];
  var vistos = {};

  var termosHPPC = [
    "cosmet", "higiene pessoal", "perfum", "protetor solar",
    "repelente", "antissept", "alisante", "capilar",
    "maquiagem", "batom", "creme", "sabonete", "shampoo",
    "xampu", "desodorante", "gel alcool", "pomada",
    "hppc", "2731"
  ];

  var termosExcluir = [
    "saneante", "medicamento", "farmaceutico", "dispositivo medico",
    "alimento", "agrotox", "fumigeno"
  ];

  var nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      var nextData = JSON.parse(nextDataMatch[1]);
      var props = nextData.props || {};
      var pageProps = props.pageProps || {};
      var items = pageProps.jsonArray || pageProps.items || pageProps.content || [];
      if (!Array.isArray(items) && pageProps.data) {
        items = pageProps.data.jsonArray || pageProps.data.items || [];
      }
      console.log("__NEXT_DATA__ encontrado, items:", items.length);
      items.forEach(function(item) { processar(item, dataExib, termosHPPC, termosExcluir, vistos, resultados); });
    } catch(e) { console.log("Erro __NEXT_DATA__:", e.message); }
  }

  if (resultados.length === 0) {
    var scriptMatches = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptMatches) {
      scriptMatches.forEach(function(script) {
        if (resultados.length > 0) return;
        try {
          var content = script.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
          var json = JSON.parse(content);
          var items = [];
          if (Array.isArray(json)) items = json;
          else if (json.jsonArray) items = json.jsonArray;
          else if (json.items) items = json.items;
          if (items.length > 0) console.log("Script JSON encontrado, items:", items.length);
          items.forEach(function(item) { processar(item, dataExib, termosHPPC, termosExcluir, vistos, resultados); });
        } catch(e) {}
      });
    }
  }

  if (resultados.length === 0) {
    var jaMatch = html.match(/jsonArray["\s]*:\s*(\[[\s\S]{10,}\])/);
    if (jaMatch) {
      try {
        var jsonStr = jaMatch[1];
        var depth = 0, end = 0;
        for (var i = 0; i < jsonStr.length; i++) {
          if (jsonStr[i] === "[") depth++;
          else if (jsonStr[i] === "]") { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        var items = JSON.parse(jsonStr.substring(0, end));
        console.log("jsonArray regex, items:", items.length);
        items.forEach(function(item) { processar(item, dataExib, termosHPPC, termosExcluir, vistos, resultados); });
      } catch(e) { console.log("Erro jsonArray regex:", e.message.substring(0, 100)); }
    }
  }

  console.log("Total HPPC encontrado:", resultados.length);
  return resultados;
}

function processar(item, dataExib, termosHPPC, termosExcluir, vistos, resultados) {
  var titulo  = limpar(item.title || item.titulo || "");
  var resumo  = limpar(item.content || item.resumo || item.abstract || item.artBody || "");
  var orgao   = (item.hierarchyStr || item.hierarchyList || item.orgaoName || item.orgao || "").toLowerCase();
  var urlTit  = item.urlTitle || item.slugify || "";
  var secao   = item.pubName || item.secao || "DO1";

  var textoCompleto = (titulo + " " + resumo + " " + orgao).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  var ehAnvisa = textoCompleto.includes("anvisa") ||
                 textoCompleto.includes("vigilancia sanitaria") ||
                 textoCompleto.includes("agencia nacional de vigilancia");
  if (!ehAnvisa) return;

  var textoNorm = textoCompleto;
  var orgaoNorm = orgao.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  var ehCosmeticosPorOrgao =
    orgaoNorm.includes("cosmeticos") || orgaoNorm.includes("cosmet") ||
    orgaoNorm.includes("higiene pessoal") || orgaoNorm.includes("perfumaria");

  var ehFumigeno = textoNorm.includes("fumigeno") || textoNorm.includes("tabaco") || textoNorm.includes("cigarro");
  if (ehFumigeno) return;

  var ehSaneantesPuro = orgaoNorm.includes("saneante") && !orgaoNorm.includes("cosmet");
  var ehHPPC = ehCosmeticosPorOrgao && !ehSaneantesPuro;

  if (!ehHPPC) {
    var ehHPPCPorTexto = termosHPPC.some(function(t) { return textoNorm.indexOf(t) !== -1; });
    if (!ehHPPCPorTexto) return;
    var ehExcluido = termosExcluir.some(function(t) { return textoNorm.indexOf(t) !== -1; });
    if (ehExcluido) return;
  }

  var uid = urlTit || titulo.substring(0, 60);
  if (vistos[uid]) return;
  vistos[uid] = true;

  var link = urlTit
    ? "https://www.in.gov.br/web/dou/-/" + urlTit
    : "https://www.in.gov.br/consulta";

  resultados.push({
    titulo:            titulo || "Publicacao ANVISA",
    empresa:           extrairEmpresa(titulo + " " + resumo),
    tipo:              classificar(titulo, resumo),
    resumo:            resumo.substring(0, 400),
    link:              link,
    secao:             secao,
    data:              dataExib,
    orgao:             limpar(item.orgaoName || item.orgao || "ANVISA"),
    numero_processo:   extrairProcesso(titulo + " " + resumo),
    numero_registro:   extrairRegistro(titulo + " " + resumo),
    dias_analise:      null,  // calculado pelo Claude via /api/claude se usado
    categoria:         extrairCategoria(titulo + " " + resumo + " " + orgao)
  });
}

function limpar(s) {
  return (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function extrairEmpresa(texto) {
  var m = texto.match(/([A-ZÀÁÂÃÉÊÍÓÔÕÚÇ][A-ZÀÁÂÃÉÊÍÓÔÕÚÇ\s]{3,60}(?:LTDA|S\.A\.|EIRELI|S\/A|EPP|ME)\.?)/i);
  return m ? m[1].trim().substring(0, 80) : "";
}

function extrairProcesso(texto) {
  var m = texto.match(/\d{5}\.\d{6}\/\d{4}-\d{2}/);
  return m ? m[0] : "";
}

function extrairRegistro(texto) {
  var m = texto.match(/\b\d{9}\b/);
  return m ? m[0] : "";
}

function extrairCategoria(texto) {
  var t = texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (t.includes("protetor solar")) return "Protetor Solar";
  if (t.includes("repelente")) return "Repelentes de Insetos";
  if (t.includes("antissept") || t.includes("gel alcool")) return "Gel Antisséptico";
  if (t.includes("alisante")) return "Alisantes Capilares";
  if (t.includes("capilar") || t.includes("shampoo") || t.includes("xampu")) return "Capilar";
  if (t.includes("maquiagem") || t.includes("batom") || t.includes("makeup")) return "Maquiagem";
  if (t.includes("perfum")) return "Perfumaria";
  if (t.includes("sabonete")) return "Sabonete";
  if (t.includes("desodorante")) return "Desodorante";
  return "Cosméticos";
}

function classificar(titulo, resumo) {
  var t = (titulo + " " + resumo).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (t.includes("deferir os registros") && !t.includes("indeferir")) return "Deferimento";
  if (t.includes("indeferir os registros") || t.includes("indeferimento")) return "Indeferimento";
  if (t.includes("cancelar os registros") || t.includes("cancelamento")) return "Cancelamento";
  if (t.includes("2731") || (t.includes("registro") && t.includes("concess"))) return "Deferimento";
  if (t.includes("238") || t.includes("revalida")) return "Revalidacao Automatica";
  if (t.includes("235")) return "Cancelamento";
  if (t.includes("230") || t.includes("formula")) return "Modificacao Formula";
  if (t.includes("289") || t.includes("rotulagem")) return "Alteracao Rotulagem";
  if (t.includes("2112") || t.includes("inclusao")) return "Inclusao Apresentacao";
  if (t.includes("indeferid")) return "Indeferimento";
  return "Publicacao ANVISA";
}

// ── Google Sheets: obter token JWT ───────────────────────────
function getGoogleToken(callback) {
  var sa;
  try {
    var raw = process.env.GOOGLE_SERVICE_ACCOUNT || "";
    sa = JSON.parse(raw);
  } catch(e) {
    return callback(new Error("GOOGLE_SERVICE_ACCOUNT inválido: " + e.message));
  }

  // JWT header + payload
  var header  = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  var now     = Math.floor(Date.now() / 1000);
  var payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  }));

  var unsigned = header + "." + payload;

  // Assinar com a chave privada usando crypto nativo do Node
  var crypto = require("crypto");
  var sign   = crypto.createSign("SHA256");
  sign.update(unsigned);
  var signature;
  try {
    signature = sign.sign(sa.private_key, "base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  } catch(e) {
    return callback(new Error("Erro ao assinar JWT: " + e.message));
  }

  var jwt = unsigned + "." + signature;

  // Trocar JWT por access token
  var body = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
             "&assertion=" + encodeURIComponent(jwt);

  var req = https.request({
    hostname: "oauth2.googleapis.com",
    path: "/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var json = JSON.parse(data);
        if (!json.access_token) return callback(new Error("Token não retornado: " + data.substring(0, 200)));
        callback(null, json.access_token);
      } catch(e) { callback(new Error("Erro ao parsear token: " + e.message)); }
    });
  });
  req.on("error", callback);
  req.write(body);
  req.end();
}

function b64url(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── Google Sheets: ler linhas existentes (coluna J = Nº Processo) ──
function lerProcessosExistentes(token, sheetId, callback) {
  var path = "/v4/spreadsheets/" + sheetId + "/values/DADOS!J:J";
  var req = https.request({
    hostname: "sheets.googleapis.com",
    path: path,
    method: "GET",
    headers: { "Authorization": "Bearer " + token }
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var json = JSON.parse(data);
        var valores = (json.values || []).flat().filter(Boolean);
        callback(null, valores);
      } catch(e) { callback(new Error("Erro ao ler planilha: " + e.message)); }
    });
  });
  req.on("error", callback);
  req.end();
}

// ── Google Sheets: verificar/criar cabeçalho ─────────────────
function garantirCabecalho(token, sheetId, callback) {
  var path = "/v4/spreadsheets/" + sheetId + "/values/DADOS!A1:N1";
  var req = https.request({
    hostname: "sheets.googleapis.com",
    path: path,
    method: "GET",
    headers: { "Authorization": "Bearer " + token }
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var json = JSON.parse(data);
        var temCabecalho = json.values && json.values.length > 0 && json.values[0].length > 0;
        if (temCabecalho) return callback(null); // já existe

        // Criar cabeçalho
        var cabecalho = [[
          "Data DOU", "Mês", "Ano", "Categoria", "Tipo de Ato",
          "Tipo Processo", "Com/Sem Exigência", "Empresa", "Produto",
          "Nº Processo", "Nº Registro", "Dias de Análise",
          "Desconsiderar?", "Observação"
        ]];

        var body = JSON.stringify({ values: cabecalho });
        var putPath = "/v4/spreadsheets/" + sheetId + "/values/DADOS!A1:N1?valueInputOption=RAW";
        var putReq = https.request({
          hostname: "sheets.googleapis.com",
          path: putPath,
          method: "PUT",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body)
          }
        }, function(putRes) {
          var d = "";
          putRes.on("data", function(c) { d += c; });
          putRes.on("end", function() { callback(null); });
        });
        putReq.on("error", callback);
        putReq.write(body);
        putReq.end();
      } catch(e) { callback(new Error("Erro ao verificar cabeçalho: " + e.message)); }
    });
  });
  req.on("error", callback);
  req.end();
}

// ── Google Sheets: adicionar linhas novas ─────────────────────
function adicionarLinhas(token, sheetId, linhas, callback) {
  var body = JSON.stringify({ values: linhas });
  var path = "/v4/spreadsheets/" + sheetId + "/values/DADOS!A1:N1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";

  var req = https.request({
    hostname: "sheets.googleapis.com",
    path: "/v4/spreadsheets/" + sheetId + "/values/DADOS!A:N:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS",
    method: "POST",
    headers: {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  }, function(res) {
    var data = "";
    res.on("data", function(c) { data += c; });
    res.on("end", function() {
      try {
        var json = JSON.parse(data);
        callback(null, json);
      } catch(e) { callback(new Error("Erro ao adicionar linhas: " + e.message)); }
    });
  });
  req.on("error", callback);
  req.write(body);
  req.end();
}

// ── Servidor HTTP ─────────────────────────────────────────────
const server = http.createServer(function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── ROTA: busca direta no DOU ────────────────────────────────
  if (req.url.startsWith("/buscar-dou") && req.method === "GET") {
    var qs = req.url.split("?")[1] || "";
    var params = {};
    qs.split("&").forEach(function(p) { var kv = p.split("="); params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ""); });
    var dataParam = params.data;
    if (!dataParam) { res.writeHead(400); res.end(JSON.stringify({error:"Parametro data obrigatorio"})); return; }
    var partes = dataParam.split("/");
    var dataAPI = partes[0] + "-" + partes[1] + "-" + partes[2];

    buscarDOU(dataAPI, function(err, html, status) {
      if (err || status !== 200) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ publicacoes: [], total: 0, erro: err ? err.message : "status " + status }));
        return;
      }
      var pubs = extrairPublicacoes(html, dataParam);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publicacoes: pubs, total: pubs.length, data: dataParam }));
    });
    return;
  }

  // ── ROTA: proxy Claude ───────────────────────────────────────
  if (req.url === "/api/claude" && req.method === "POST") {
    if (!CHAVE) { res.writeHead(500); res.end(JSON.stringify({error:"SEM_CHAVE"})); return; }
    let body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) { res.writeHead(400); res.end(JSON.stringify({error:"JSON invalido"})); return; }
      parsed.model = "claude-sonnet-4-6";
      if (!parsed.max_tokens || parsed.max_tokens > 4096) parsed.max_tokens = 4096;
      delete parsed.tools;
      const bf = JSON.stringify(parsed);
      const opcoes = {
        hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
        headers: { "Content-Type":"application/json", "x-api-key":CHAVE, "anthropic-version":"2023-06-01", "Content-Length":Buffer.byteLength(bf) }
      };
      const proxy = https.request(opcoes, function(apiRes) {
        let dados = "";
        apiRes.on("data", function(c) { dados += c; });
        apiRes.on("end", function() {
          res.writeHead(apiRes.statusCode, {"Content-Type":"application/json"});
          res.end(dados);
        });
      });
      proxy.on("error", function(e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); });
      proxy.write(bf); proxy.end();
    });
    return;
  }

  // ── ROTA NOVA: salvar no Google Sheets ───────────────────────
  if (req.url === "/api/salvar-sheets" && req.method === "POST") {
    var sheetId = process.env.GOOGLE_SHEET_ID;
    if (!sheetId) {
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:"GOOGLE_SHEET_ID não configurado no servidor."}));
      return;
    }
    if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:"GOOGLE_SERVICE_ACCOUNT não configurado no servidor."}));
      return;
    }

    var body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      var processos;
      try { processos = JSON.parse(body).processos; } catch(e) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"JSON inválido"}));
        return;
      }

      if (!processos || processos.length === 0) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"Nenhum processo enviado."}));
        return;
      }

      console.log("Salvando " + processos.length + " processo(s) no Sheets...");

      // 1. Obter token
      getGoogleToken(function(err, token) {
        if (err) {
          console.error("Erro token:", err.message);
          res.writeHead(500, {"Content-Type":"application/json"});
          res.end(JSON.stringify({error:"Erro de autenticação Google: " + err.message}));
          return;
        }

        // 2. Garantir cabeçalho
        garantirCabecalho(token, sheetId, function(err) {
          if (err) console.warn("Aviso cabeçalho:", err.message);

          // 3. Ler processos já existentes (deduplicação)
          lerProcessosExistentes(token, sheetId, function(err, existentes) {
            if (err) { existentes = []; console.warn("Aviso leitura:", err.message); }

            // 4. Filtrar apenas processos novos
            var meses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                         "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
            var linhasNovas = [];
            var duplicatas = 0;

            processos.forEach(function(p) {
              var numProc = p.numero_processo || p.processo || "";
              // Deduplicação: pular se número de processo já existe
              if (numProc && existentes.includes(numProc)) {
                duplicatas++;
                return;
              }

              // Montar a linha na mesma ordem do cabeçalho
              var dataDOU = p.data || "";
              var partes = dataDOU.split("/");
              var mes = "", ano = "";
              if (partes.length === 3) {
                var idx = parseInt(partes[1], 10) - 1;
                mes = meses[idx] || "";
                ano = partes[2] || "";
              }

              var tipoAto  = p.tipo || p.tipoAto || "";
              var tipoProc = inferirTipoProcesso(tipoAto);
              var exigencia = inferirExigencia(tipoAto, tipoProc);

              linhasNovas.push([
                dataDOU,                          // A - Data DOU
                mes,                              // B - Mês
                ano,                              // C - Ano
                p.categoria || "",                // D - Categoria
                tipoAto,                          // E - Tipo de Ato
                tipoProc,                         // F - Tipo Processo
                exigencia,                        // G - Com/Sem Exigência
                p.empresa || "",                  // H - Empresa
                p.titulo || "",                   // I - Produto
                numProc,                          // J - Nº Processo
                p.numero_registro || p.registro || "", // K - Nº Registro
                p.dias_analise || "",             // L - Dias de Análise
                "Não",                            // M - Desconsiderar?
                p.resumo ? p.resumo.substring(0, 200) : "" // N - Observação
              ]);
            });

            if (linhasNovas.length === 0) {
              res.writeHead(200, {"Content-Type":"application/json"});
              res.end(JSON.stringify({
                sucesso: true,
                adicionados: 0,
                duplicatas: duplicatas,
                mensagem: "Todos os " + duplicatas + " processo(s) já existem na planilha."
              }));
              return;
            }

            // 5. Adicionar linhas novas
            adicionarLinhas(token, sheetId, linhasNovas, function(err, resultado) {
              if (err) {
                console.error("Erro ao adicionar linhas:", err.message);
                res.writeHead(500, {"Content-Type":"application/json"});
                res.end(JSON.stringify({error:"Erro ao gravar na planilha: " + err.message}));
                return;
              }

              console.log("✅ " + linhasNovas.length + " linha(s) adicionada(s). " + duplicatas + " duplicata(s) ignorada(s).");
              res.writeHead(200, {"Content-Type":"application/json"});
              res.end(JSON.stringify({
                sucesso: true,
                adicionados: linhasNovas.length,
                duplicatas: duplicatas,
                mensagem: linhasNovas.length + " processo(s) novo(s) salvo(s). " + duplicatas + " já existia(m)."
              }));
            });
          });
        });
      });
    });
    return;
  }

  // ── ROTA: extrair processos individuais de uma resolução ─────
  if (req.url === "/api/extrair-processos" && req.method === "POST") {
    if (!CHAVE) {
      res.writeHead(500, {"Content-Type":"application/json"});
      res.end(JSON.stringify({error:"Chave API não configurada"}));
      return;
    }

    var body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      var link, dataDOU;
      try {
        var parsed = JSON.parse(body);
        link    = parsed.link;
        dataDOU = parsed.data || "";
      } catch(e) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"JSON inválido"}));
        return;
      }

      if (!link || !link.startsWith("https://www.in.gov.br")) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"Link inválido"}));
        return;
      }

      // 1. Buscar HTML da resolução
      var urlObj = new URL(link);
      var reqOpts = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + (urlObj.search || ""),
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "pt-BR,pt;q=0.9",
        }
      };

      var pageReq = https.request(reqOpts, function(pageRes) {
        var chunks = [];
        pageRes.on("data", function(c) { chunks.push(c); });
        pageRes.on("end", function() {
          var html = Buffer.concat(chunks).toString("utf8");

          // 2. Extrair texto limpo do HTML (remover tags)
          var texto = html
            .replace(/<script[\s\S]*?<\/script>/gi, "")
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s{2,}/g, "\n")
            .trim()
            .substring(0, 12000); // limitar para não estourar contexto

          // 3. Mandar para o Claude extrair os processos
          var prompt = "Você receberá o texto de uma Resolução-RE da ANVISA publicada no Diário Oficial da União.\n\n" +
            "Extraia TODOS os processos de cosméticos/HPPC (higiene pessoal, perfumaria e cosméticos) listados.\n" +
            "IGNORE processos de saneantes, medicamentos ou outros que não sejam cosméticos/HPPC.\n\n" +
            "Para cada processo, extraia exatamente:\n" +
            "- empresa: razão social completa\n" +
            "- produto: nome do produto\n" +
            "- numero_processo: formato 00000.000000/0000-00\n" +
            "- numero_registro: número de 9 dígitos\n" +
            "- tipo_ato: descrição do ato (ex: Registro de produtos cosméticos, Revalidação de Registro, etc)\n" +
            "- tipo_processo: 'Registro Novo', 'Pós Registro Simplificado' ou 'Pós Registro Não Simplificado'\n" +
            "- exigencia: 'Com Exigência', 'Sem Exigência' ou '' se não informado\n" +
            "- categoria: 'Protetor Solar', 'Repelentes de Insetos', 'Gel Antisséptico', 'Alisantes Capilares', 'Pomadas Capilares' ou 'Cosméticos'\n" +
            "- dias_analise: número inteiro de dias ou null se não informado\n" +
            "- desconsiderar: 'Sim' se houver indicação de desconsiderar no cálculo, caso contrário 'Não'\n\n" +
            "Responda SOMENTE com JSON válido, sem texto antes ou depois:\n" +
            "{\"processos\": [...], \"total\": N, \"resolucao\": \"título da resolução\"}\n\n" +
            "DATA DO DOU: " + dataDOU + "\n\n" +
            "TEXTO DA RESOLUÇÃO:\n" + texto;

          var payload = JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            messages: [{ role: "user", content: prompt }]
          });

          var apiOpts = {
            hostname: "api.anthropic.com",
            path: "/v1/messages",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": CHAVE,
              "anthropic-version": "2023-06-01",
              "Content-Length": Buffer.byteLength(payload)
            }
          };

          var apiReq = https.request(apiOpts, function(apiRes) {
            var dados = "";
            apiRes.on("data", function(c) { dados += c; });
            apiRes.on("end", function() {
              try {
                var resposta = JSON.parse(dados);
                var texto_claude = (resposta.content && resposta.content[0] && resposta.content[0].text) || "{}";

                // Extrair JSON da resposta
                var inicio = texto_claude.indexOf("{");
                var fim    = texto_claude.lastIndexOf("}") + 1;
                var jsonStr = inicio >= 0 ? texto_claude.substring(inicio, fim) : "{}";
                var resultado = JSON.parse(jsonStr);

                // Adicionar data a cada processo
                var processos = resultado.processos || [];
                processos.forEach(function(p) { p.data = dataDOU; });

                // Consultar ANVISA para preencher dias_analise automaticamente
                consultarDiasANVISA(processos, dataDOU, function(processosComDias) {
                  resultado.processos = processosComDias;
                  res.writeHead(200, {"Content-Type":"application/json"});
                  res.end(JSON.stringify(resultado));
                });
              } catch(e) {
                console.error("Erro ao parsear resposta Claude:", e.message);
                res.writeHead(500, {"Content-Type":"application/json"});
                res.end(JSON.stringify({error:"Erro ao interpretar resposta: " + e.message, processos:[]}));
              }
            });
          });

          apiReq.on("error", function(e) {
            res.writeHead(500, {"Content-Type":"application/json"});
            res.end(JSON.stringify({error: e.message, processos:[]}));
          });
          apiReq.write(payload);
          apiReq.end();
        });
      });

      pageReq.on("error", function(e) {
        res.writeHead(500, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"Erro ao buscar resolução: " + e.message, processos:[]}));
      });
      pageReq.setTimeout(25000, function() {
        pageReq.destroy();
        res.writeHead(500, {"Content-Type":"application/json"});
        res.end(JSON.stringify({error:"Timeout ao buscar resolução", processos:[]}));
      });
      pageReq.end();
    });
    return;
  }

  // ── Arquivos estáticos ───────────────────────────────────────
  servArquivo(res, path.join(__dirname, req.url === "/" ? "/index.html" : req.url));
});

// ── Helpers para inferir campos não disponíveis diretamente ──
function inferirTipoProcesso(tipoAto) {
  var t = (tipoAto || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (t.includes("deferimento") || t.includes("registro") || t.includes("concessao")) return "Registro Novo";
  if (t.includes("inclusao") || t.includes("simplific")) return "Pós Registro Simplificado";
  if (t.includes("revalid") || t.includes("alterac") || t.includes("modificac") || t.includes("rotulagem")) return "Pós Registro Não Simplificado";
  if (t.includes("cancelamento")) return "Pós Registro Simplificado";
  return "";
}

function inferirExigencia(tipoAto, tipoProc) {
  if (tipoProc !== "Registro Novo") return ""; // só se aplica a Registro Novo
  return ""; // não é possível inferir sem dados do DOU — campo fica em branco para preenchimento manual se necessário
}

// ── Consulta ANVISA: preencher Data de Protocolo e Dias de Análise ──
function consultarProcessoANVISA(numeroProcesso, callback) {
  // Formatar número do processo para a API: remover pontos, barras e traços
  // Ex: "25351.185292/2025-59" → "25351185292202559"
  var numLimpo = (numeroProcesso || "").replace(/[\.\-\/]/g, "");
  if (!numLimpo || numLimpo.length < 10) return callback(null, null);

  var path = "/api/consulta/cosmeticos/registrados/?count=1&filter%5BnumeroProcesso%5D=" +
             encodeURIComponent(numeroProcesso);

  var opts = {
    hostname: "consultas.anvisa.gov.br",
    path: path,
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Origin": "https://consultas.anvisa.gov.br",
      "Referer": "https://consultas.anvisa.gov.br/"
    }
  };

  var req = https.request(opts, function(apiRes) {
    var data = "";
    apiRes.on("data", function(c) { data += c; });
    apiRes.on("end", function() {
      try {
        var json = JSON.parse(data);
        var content = json.content || [];
        if (content.length === 0) return callback(null, null);

        var item = content[0];
        // A API retorna dataProtocolo no formato "dd/MM/yyyy" ou "yyyy-MM-dd"
        var dataProtocolo = item.dataProtocolo || item.dataAbertura || item.dataEntrada || null;
        callback(null, { dataProtocolo: dataProtocolo, situacao: item.situacaoRegistro || "" });
      } catch(e) {
        callback(null, null);
      }
    });
  });

  req.on("error", function() { callback(null, null); });
  req.setTimeout(8000, function() { req.destroy(); callback(null, null); });
  req.end();
}

function calcularDias(dataProtocolo, dataDOU) {
  try {
    // dataProtocolo pode vir como "dd/MM/yyyy" ou "yyyy-MM-dd"
    var dtProt, dtDOU;

    if (dataProtocolo && dataProtocolo.includes("/")) {
      var p = dataProtocolo.split("/");
      if (p[0].length === 4) {
        // yyyy/MM/dd
        dtProt = new Date(parseInt(p[0]), parseInt(p[1])-1, parseInt(p[2]));
      } else {
        // dd/MM/yyyy
        dtProt = new Date(parseInt(p[2]), parseInt(p[1])-1, parseInt(p[0]));
      }
    } else if (dataProtocolo && dataProtocolo.includes("-")) {
      var p2 = dataProtocolo.split("-");
      dtProt = new Date(parseInt(p2[0]), parseInt(p2[1])-1, parseInt(p2[2]));
    } else {
      return null;
    }

    // dataDOU no formato "dd/MM/yyyy"
    if (dataDOU && dataDOU.includes("/")) {
      var d = dataDOU.split("/");
      dtDOU = new Date(parseInt(d[2]), parseInt(d[1])-1, parseInt(d[0]));
    } else {
      return null;
    }

    if (isNaN(dtProt.getTime()) || isNaN(dtDOU.getTime())) return null;

    var diffMs = dtDOU.getTime() - dtProt.getTime();
    var diffDias = Math.round(diffMs / (1000 * 60 * 60 * 24));
    return diffDias >= 0 ? diffDias : null;
  } catch(e) {
    return null;
  }
}

function consultarDiasANVISA(processos, dataDOU, callback) {
  if (!processos || processos.length === 0) return callback([]);

  var resultado = processos.slice(); // cópia
  var pendentes = 0;

  resultado.forEach(function(p) {
    // Só consultar se tiver número de processo e ainda não tiver dias
    if (!p.numero_processo || p.dias_analise) return;
    pendentes++;
  });

  if (pendentes === 0) return callback(resultado);

  var concluidos = 0;

  resultado.forEach(function(p, idx) {
    if (!p.numero_processo || p.dias_analise) return;

    // Pequeno delay entre consultas para não sobrecarregar a ANVISA
    setTimeout(function() {
      consultarProcessoANVISA(p.numero_processo, function(err, dados) {
        if (dados && dados.dataProtocolo) {
          var dias = calcularDias(dados.dataProtocolo, p.data || dataDOU);
          if (dias !== null) {
            resultado[idx].dias_analise = dias;
            resultado[idx].data_protocolo = dados.dataProtocolo;
            console.log("✅ " + p.numero_processo + " → " + dias + " dias (prot: " + dados.dataProtocolo + ")");
          }
        } else {
          console.log("⚠️  " + p.numero_processo + " → sem data protocolo na ANVISA");
        }

        concluidos++;
        if (concluidos >= pendentes) {
          callback(resultado);
        }
      });
    }, idx * 300); // 300ms entre cada consulta
  });
}

server.listen(PORT, "0.0.0.0", function() {
  console.log("RadarVisa v3 na porta " + PORT);
  console.log("Chave Anthropic: " + (CHAVE ? "OK" : "NAO CONFIGURADA"));
  console.log("Google Sheet ID: " + (process.env.GOOGLE_SHEET_ID ? "OK" : "NAO CONFIGURADO"));
  console.log("Google Service Account: " + (process.env.GOOGLE_SERVICE_ACCOUNT ? "OK" : "NAO CONFIGURADO"));
});
