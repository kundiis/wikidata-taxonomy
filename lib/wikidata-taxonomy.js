var chalk	= require('chalk')
var request = require('request-promise')
var wdk 	= require('wikidata-sdk')

exports = module.exports = {
  normalizeId: normalizeId,
  query: sparqlQuery,
  sparql: {
    queries:   sparqlQueries,
    instances: instancesSparqlQuery,
    hierarchy: mainSparqlQuery,
  },
  build: buildTaxonomy,
  serialize: serialize,  
  serializer: {
    tree: serializeTree,
    json: serializeJSON,
    csv:  serializeCSV
  },
}

// Normalize Wikidata identifier and return string or undefined
function normalizeId(id) {
  try {
    return wdk.normalizeId(id)
  } catch (err) {
    return
  }
}

// Ask query.wikidata.org via SPARQL promise simplified result
function sparqlQuery(sparql) {
  var url = wdk.sparqlQuery(sparql)
  return request(url).then(wdk.simplifySparqlResults)
}

// get list of SPARQL queries to build the taxonomy
function sparqlQueries(id, env) {
  var queries = [ exports.sparql.hierarchy(id, env) ]
  if (env.instances && !env.properties) {
    queries.push(exports.sparql.instances(id, env))
  }
  return queries
}

// construct basic SPARQL query
function mainSparqlQuery(root, env) {
  var language       = env.language
  var countInstances = !env.noCountInstances
  var property       = env.properties ? 'P1647' : 'P279'
  var path           = env.children ? '?' : '*';
  var reachable      = env.reverse
                     ? "wd:"+root+" wdt:"+property+path+" ?item"
                     : "?item wdt:"+property+path+" wd:"+root

  var sparql = `SELECT ?item ?itemLabel ?broader ?parents ?instances ?sites
WHERE {
    {
        SELECT ?item (count(distinct ?parent) as ?parents) {
            ${reachable}
            OPTIONAL { ?item wdt:${property} ?parent }
        } GROUP BY ?item
    }
`
    if (!env.property) { // TODO: get usage of property
      if (countInstances) {
        sparql += `    {
        SELECT ?item (count(distinct ?element) as ?instances) {
            ${reachable}
            OPTIONAL { ?element wdt:P31 ?item }
        } GROUP BY ?item
    }
`     }
      sparql += `    {
        SELECT ?item (count(distinct ?site) as ?sites) {
            ${reachable}
            OPTIONAL { ?site schema:about ?item }
        } GROUP BY ?item
    }
`
    }

    sparql += `    OPTIONAL { ?item wdt:${property} ?broader }
    SERVICE wikibase:label {
        bd:serviceParam wikibase:language "${language}" .
    }
}`
	return sparql
}

// SPARQL query to get all instances
function instancesSparqlQuery(root, env) {
  var language = env.language

  return `SELECT ?class ?classLabel ?instance ?instanceLabel WHERE {
    ?class wdt:P279* wd:${root} .
    ?instance wdt:P31 ?class .
    SERVICE wikibase:label {
        bd:serviceParam wikibase:language "${language}" .
    }
}`
}

// Build graph data from root item and SPARQL results
function buildTaxonomy(root, results, reverse) {
  var graph = buildTree(results[0])

  graph.root = root

  if (results[1]) {
    var instances = graph.instances = {}
    var items = graph.items
    results[1].forEach(function(row) {
      var id = row.class.value
      if (!instances[id]) instances[id] = []
      if (!items[row.instance.value]) {
        items[row.instance.value] = row.instance
      }
      instances[id].push(row.instance.value)
    })

    for(var id in instances) {
      instances[id] = instances[id].sort(function(x,y) {
        return items[x].value.substr(1) - items[y].value.substr(1)
      })
    }
  }

  if (reverse) {
    var tmp = graph.narrower
    graph.narrower = graph.broader
    graph.broader = tmp
  }

  return graph;
}

// build tree structure from results (only called internally)
function buildTree(results) {
  var items    = {}
  var narrower = {}
  var broader  = {}

  results.forEach(function(row) {
    var qid       = row.item.value
    var broaderId = row.broader

    if (broaderId) {
      if (narrower[broaderId]) {
        narrower[broaderId].push(qid)
      } else {
        narrower[broaderId] = [qid]
      }
    }

    if (!items[qid]) {
      item = {
        value:     qid,
        label:     row.item.label || "",
        parents:   row.parents,
        instances: row.instances,
        sites:     row.sites,
        broader:   []
      }
      if (item.label == row.item.value) item.label = ""
      items[qid] = item
    }
  })

  for (var id in narrower) {
    // sort child nodes by Wikidata id
    narrower[id] = narrower[id].sort(function(x,y) {
      return x.substr(1) - y.substr(1)
    })
    // add reverse
    narrower[id].forEach(function(b) {
      if (!broader[b]) broader[b] = []
      broader[b].push(id)
    })
  }

  for (var id in items) {
    var item = items[id]
    item.otherparents = item.parents
    if (broader[id]) {
      broader[id].forEach(function(node) {
        if (items[node]) item.otherparents--
      })
    }
  }

  return { items: items, narrower: narrower, broader: broader }
}

// taxonomy in given format or tree format
function serialize(graph, format) {
  if (format == 'json') {
    return serializeJSON(graph)
  } else if (format == 'csv') {
    return serializeCSV(graph, graph.root, 0)
  } else {
    return serializeTree(graph, graph.root, "")
  }
}

// taxonomy in tree format
function serializeTree( graph, id, depth ) {
  var node = graph.items[id];
  if (!node) return ''

  var label     = node.label == "" ? "???" : node.label
  var sites     = node.sites ? ' •' + node.sites : ''
  var instances = (node.instances && !graph.instances)
                ? ' ×' + node.instances : ''
  var parents   = node.otherparents
                ? ' ' + Array(node.otherparents+1).join('↑') : ''
  var narrower  = graph.narrower[id] || []
  var etc       = node.visited + narrower.length ? ' …'
                : (node.multi > 1 ? '=' : '') // TODO: set multihierarchy

  // check whether item is an instance at level 0
  var color = (id.substr(0,1) == 'Q' && !depth && !node.instances && 
               !node.otherparents && !narrower.length) 
            ? 'cyan' : 'blue'

  var string = chalk[color](label)
             + chalk.dim(' (') + chalk.green(id) + chalk.dim(')')
             + chalk.yellow(sites) + chalk.cyan(instances)
             + chalk.red(parents + etc)
             + "\n"

  if (node.visited) return string;
  node.visited = true;

  if (graph.instances) {
    var instances = graph.instances[id] || []
    for(var i=0; i<instances.length; i++) {
      var item = graph.items[ instances[i] ]

      var label  = item.label == "" ? "???" : item.label
      var id     = item.value;
      var prefix = narrower.length ? '|' : ' ';

      string += chalk.dim(depth + prefix)
      string += chalk.dim( item.visited ? '=' : '-' )
      string += chalk.cyan(label)
      string += chalk.dim(' (') + chalk.green(id) + chalk.dim(')')
      string +=  "\n"

      item.visited = true
    }
  }

  for(var i=0; i<narrower.length; i++) {
    var cur  = narrower[i]
    var last = (i == narrower.length-1)
    if (graph.items[cur].visited) {
      prefix = last ? '╘══' : '╞══'
    } else {
      prefix = last ? '└──' : '├──'
    }
    string += chalk.dim(depth + prefix)
    string += serializeTree(graph, cur, depth + (last ? '   ' : '│  '));
  }

  return string
}

// taxonomy in CSV format
function serializeCSV( graph, id, depth ) {
  var node = graph.items[id];
  var csv = ''
  if (!node) return csv

  var label = node.label.replace(',',' ') // for CSV

  if (depth==0) {
    csv += "level,id,label,sites,instances,parents\n"
  }

  var row = [
    Array(depth+1).join( node.visited ? '=' : '-' ),
    id,
    label,
    node.sites,
    node.instances,
    Array(node.otherparents+1).join('^')
  ];
  csv += row.join(',') + "\n"

  if (!node.visited) {
    node.visited = true;
    var narrower = graph.narrower[id] || []
    narrower.forEach( (child) => {
      csv += serializeCSV(graph, child, depth+1);
    })
  }

  return csv
}

// taxonomy in pretty JSON format
function serializeJSON(graph) {
  return JSON.stringify(graph, null, 4) + '\n'
}
