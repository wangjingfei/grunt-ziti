var path = require('path');
var spawn = require('child_process').spawn;
var fontOptimizer = path.normalize(__dirname + '/../vendor/font-optimizer');
var webifyPath = path.normalize(__dirname + '/../vendor/webify');
var Q = require('q');

module.exports = function(grunt) {

  grunt.registerMultiTask('ziti', 'Subsetting, optimizing and converting ' +
    'large font files.', function() {

    if (!grunt.file.isDir(fontOptimizer)) {
      return grunt.fail.fatal('Can\'t find font-optimizer.');
    }

    var finish = this.async();
    var files = this.files;
    var options = this.options();

    var regexTTF = new RegExp('\.ttf$', 'i');
    var regexHTML = new RegExp('\.html?$', 'i');
    var regexJS = new RegExp('\.js$', 'i');
    var regexCSS = new RegExp('\.css$', 'i');

    Q.
    fcall(function() {
      if (!grunt.file.isFile(webifyPath)) {
        var url = webifyURL();
        grunt.log.writeln('Can\'t find webify. Now downloading from:');
        grunt.log.writeln(url);
        return download(url, webifyPath, 0755);
      }
    }).
    catch(function(e) {
      grunt.fail.fatal(e);
    }).
    then(function() {
      var bundle = [];
      for (var i = 0; i < files.length; i++) {
        var file = files[i];

        var ttf = [];
        var html = [];
        var js = [];
        var css = [];

        for (var j = 0; j < file.src.length; j++) {
          var src = file.src[j];
          if (regexTTF.test(src)) {
            ttf.push(src);
          } else if (regexHTML.test(src)) {
            html.push(src);
          } else if (regexJS.test(src)) {
            js.push(src);
          } else if (regexCSS.test(src)) {
            css.push(src);
          }
        }

        if (ttf.length === 0) {
          grunt.fail.fatal('Can\'t find any TTF file.');
        } else if (ttf.length > 1) {
          grunt.log.warn('There are ' + ttf.length + ' TTF files. Only ' +
            ttf[0] + ' will be used.');
        } else if (ttf[0] === file.dest) {
          grunt.fail.fatal('It\'s not recommended to overwrite the ' +
            'TTF source file.');
        }

        var src = path.resolve(ttf[0]);
        var dest = path.resolve(file.dest);

        bundle.push({
          originalSrc: ttf[0],
          src: src,
          dest: dest,
          destp1: dest + '.p1',
          options: options,
          html: html,
          css: css,
          js: js
        });
      }
      return bundle;
    }).
    then(function(bundle) {
      return bundle.reduce(function(previous, current) {
        return previous.then(function() {
          return [
            gettext('html'),
            gettext('js'),
            gettext('css'),
            writeCharsFile,
            subset,
            obfuscate,
            webify,
            clean
          ].reduce(Q.when, Q(current));
        });
      }, Q());
    }).
    progress(function(bundle) {
      grunt.log[bundle[0]].apply(null, bundle.slice(1));
    }).
    catch(function(error) {
      grunt.fail.fatal(error);
    }).
    then(function(bundle) {
      finish();
    });

  });

  function writeCharsFile(bundle) {
    grunt.log.writeln('Characters: ' + bundle.chars);
    grunt.file.write(bundle.destp1, bundle.chars);
    return bundle;
  }

  function clean(bundle) {
    grunt.file.delete(bundle.destp1);
    return bundle;
  }

  var gettextFunctions = {
    html: gettextHTMLContent,
    js:   gettextJSContent,
    css:  gettextCSSContent
  };

  function gettext(filetype) {
    return function(bundle) {
      return bundle[filetype].reduce(function(previous, current) {
        return previous.then(function() {
          return gettextFunctions[filetype](bundle, grunt.file.read(current));
        });
      }, Q());
    };
  }

};

function addChars(bundle, string) {
  bundle.chars = bundle.chars || '';
  var i = 0, l = string.length;
  for (; i < l; i++) {
    if (bundle.chars.indexOf(string[i]) === -1) {
      bundle.chars += string[i];
    }
  }
}

function gettextHTMLContent(bundle, content) {
  var htmlparser = require('htmlparser2');
  var htmlOptions = bundle.options.html || {};
  var deferred = Q.defer();
  var addText = false;
  var parser = new htmlparser.Parser({
    onopentag: function(name, attribs) {
      addText = false;

      var elements = htmlOptions.elements || [];
      for (var i = 0; i < elements.length; i++) {
        if (name === elements[i]) {
          return addText = true;
        }
      }

      var classes = htmlOptions.classes || [];
      for (var i = 0; i < classes.length; i++) {
        if (hasClass(attribs.class, classes[i])) {
          return addText = true;
        }
      }

      var attributes = htmlOptions.attributes || [];
      for (var i = 0; i < attributes.length; i++) {
        if (attribs.hasOwnProperty(attributes[i])) {
          return addChars(bundle, attribs[attributes[i]]);
        }
      }
    },
    ontext: function(text) {
      if (addText === true) {
        return addChars(bundle, text.trim());
      }
    },
    onend: function() {
      deferred.resolve(bundle);
    }
  });
  parser.write(content);
  parser.end();
  return deferred.promise;
}

var BLANK = '[\\s\\t\\n\\r\\f]{0,}';

function gettextJSContent(bundle, content) {
  var jsOptions = bundle.options.js || {};
  var funcs = jsOptions.functions || [];
  if (funcs.length === 0) return bundle;

  var funcNames = funcs.map(function(f) { return escapeRegex(f); });

  var functions = '(' + funcNames.join('|') + ')' +
    BLANK + '\\(' + BLANK + '([\'"])([\\S\\s]+?)';
  var functionsRegExp = new RegExp(functions + '[\'"]' + BLANK + '\\)');
  var functionsRegExpGlobal = new RegExp(functions + '\\)', 'g');

  var concat = '^' + BLANK + '\\+' + BLANK + '$';
  var concatRegExp = new RegExp(concat);

  var mRegExp = new RegExp('[\'"]' + BLANK + '\\+' + BLANK + '$', 'mg');
  var mRegExp2 = new RegExp('(\\()' + BLANK + '([\'"])');
  var mRegExp3 = new RegExp('^' + BLANK + '[\'"]' + BLANK, 'mg');

  content = content.replace(/(['"])(.+?|)\)(.+?|)\1/g, '$1$2\x00$3$1');
  var m = content.match(functionsRegExpGlobal) || [];

  for (var i = 0; i < m.length; i++) {
    var t = m[i];
    t = t.replace(/[^'"]+$/, ')');
    // turn oneline concat string to multiline
    var s = t.split(/['"]/);
    s = s.map(function(S) {
      if (concatRegExp.test(S)) {
        return (' ' + S + ' ').replace(/[\s\t\n\r\f]{1,}/g, '\n');
      }
      return S;
    });
    t = s.join('"');
    // multiline string:
    t = t.replace(mRegExp, '');
    t = t.replace(mRegExp2, '$1$2');
    t = t.replace(mRegExp3, '');
    t = t.replace(/\n/g, '');
    t = t.match(functionsRegExp);
    if (t) addChars(bundle, t[3].replace(/\x00/g, ')'));
  }
  return bundle;
}

function gettextCSSContent(bundle, content) {
  var cssOptions = bundle.options.css || {};
  var selectors = cssOptions.selectors || [];
  if (selectors.length === 0) return bundle;

  selectors = selectors.map(function(s) { return escapeRegex(s); });

  var rules = '[;{}]' + BLANK + '(' + selectors.join('|') + ')' + BLANK +
    '(\\{[\\S\\s]+?\\})';
  var rulesRegExp = new RegExp(rules);
  var rulesRegExpGlobal = new RegExp(rules, 'g');

  var contentProp = 'content:' + BLANK + '[\'"]([\\S\\s]+?)[\'"]' + BLANK +
    '[;}]';
  var contentRegExp = new RegExp(contentProp);
  var contentRegExpGlobal = new RegExp(contentProp, 'g');

  var split = new RegExp('[\'"][\\s\\t]{0,}[\'"]');

  content = ';' + content;
  // replace '}' in strings to NULL to not match them in rulesRegExp
  content = content.replace(/(['"])(.+?|)\}(.+?|)\1/g, '$1$2\x00$3$1');

  var m = content.match(rulesRegExpGlobal);
  for (var i = 0; i < m.length; i++) {
    t = m[i].match(rulesRegExp);
    var c = t[2].match(contentRegExpGlobal);
    for (var j = c.length - 1; j >= 0; j--) {
      var a = c[j].match(contentRegExp);
      var s = a[1].replace(/\x00/g, '}').split(split).join('');

      // skip invalid property value:
      if (/['"]$/.test(s) || /\n|\r|\f/.test(s)) continue;

      s = s.replace(/[\s\t]{0,}/g, '');
      if (s) {
        addChars(bundle, s);
        break; // only use last valid property value
      }
    }
  }
  return bundle;
}

function escapeRegex(string) {
  return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1');
}

function hasClass(classNames, className) {
  classNames = (' ' + classNames + ' ').replace(/[\t\r\n\f]/g, ' ');
  className = ' ' + className + ' ';
  return classNames.indexOf(className) !== -1;
}

function subset(bundle) {
  var deferred = Q.defer();
  setTimeout(function() {
    deferred.notify([ 'write', 'Subsetting ' + bundle.originalSrc + '... ' ]);
  }, 0);
  var subset = spawn('./subset.pl', [
    '--charsfile=' + bundle.destp1, bundle.src, bundle.destp1
  ], {
    cwd: fontOptimizer
  });
  subset.on('close', function(code) {
    if (code === 0) {
      deferred.notify([ 'ok' ]);
      deferred.resolve(bundle);
    } else {
      deferred.notify([ 'error' ]);
      deferred.reject('subset exited with code: ' + code);
    }
  });
  return deferred.promise;
}

function obfuscate(bundle) {
  var deferred = Q.defer();
  setTimeout(function() {
    deferred.notify([ 'write', 'Obfuscating... ' ]);
  }, 0);
  var obfuscate = spawn('./obfuscate-font.pl', [
    '--all', bundle.destp1, bundle.dest
  ], {
    cwd: fontOptimizer
  });
  obfuscate.on('close', function(code) {
    if (code === 0) {
      deferred.notify([ 'ok' ]);
      deferred.resolve(bundle);
    } else {
      deferred.notify([ 'error' ]);
      deferred.reject('obfuscate exited with code: ' + code);
    }
  });
  return deferred.promise;
}

function webify(bundle) {
  var deferred = Q.defer();
  setTimeout(function() {
    deferred.notify([ 'write', 'Generating web fonts... ' ]);
  }, 0);
  var obfuscate = spawn(webifyPath, [ bundle.dest ]);
  obfuscate.on('close', function(code) {
    if (code === 0) {
      deferred.notify([ 'ok' ]);
      deferred.resolve(bundle);
    } else {
      deferred.notify([ 'error' ]);
      deferred.reject('webify exited with code: ' + code);
    }
  });
  return deferred.promise;
}

function download(url, path, chmod) {
  var deferred = Q.defer();
  var http = require('http');
  http.get(url, function(res) {
    if (res.statusCode === 301 || res.statusCode === 302) {
      url = res.headers.location;
      deferred.notify([ 'ok', 'Redirected to: ' + url ]);
      return deferred.resolve(download(url, path, chmod));
    } else if (res.statusCode !== 200) {
      return deferred.reject('Fail to download. Status: ' + res.statusCode);
    }
    var fs = require('fs');
    var file = fs.createWriteStream(path);
    var total = parseInt(res.headers['content-length']);
    var done = 0;
    res.on('data', function(data) {
      file.write(data);
      done += data.length;
      process.stdout.clearLine();
      process.stdout.cursorTo(0);
      deferred.notify([ 'write', (done / total * 100).toFixed(2) + '%, ' +
        done + ' of ' + total + ' bytes downloaded... ' ]);
    });
    res.on('end', function() {
      file.end();
      deferred.notify([ 'writeln' ]);
      deferred.notify([ 'ok', 'Download completed: ' + path ]);
      if (chmod) {
        fs.chmodSync(path, chmod);
      }
      deferred.resolve();
    });
  });
  return deferred.promise;
}

function webifyURL() {
  var url = 'http://sourceforge.net/projects/webify/files';
  switch (process.platform) {
  case 'darwin':
    url += '/mac/webify-0.1.6.0'
    break;
  case 'linux':
    url += (process.arch === 'x64' ? '/linux' : '/linux32') + '/webify-0.1.6.0'
    break;
  case 'win32':
    url += '/windows/webify-0.1.6.0.exe'
    break;
  default:
    grunt.fail.fatal('Can\'t download webify.');
  }
  url += '/download';
  return url;
}
