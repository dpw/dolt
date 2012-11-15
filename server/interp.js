'use strict';

var parser = require('./javascript');
var fs = require('fs');


function Environment(parent) {
    this.frame = {};
    this.parent = parent;
}

Environment.prototype.lookup = function (symbol, cont, econt) {
    var env = this;
    while (env) {
        if (symbol in env.frame)
            return tramp(cont, env.frame[symbol]);

        env = env.parent;
    }

    return tramp(econt, new Error("unbound variable '" + symbol + "'"));
};

Environment.prototype.bind = function (symbol, val) {
    this.frame[symbol] = val;
};

Environment.prototype.assign = function (symbol, val, cont, econt) {
    var env = this;
    while (env) {
        if (symbol in env.frame) {
            env.frame[symbol] = val;
            return tramp(cont, val);
        }

        env = env.parent;
    }

    return tramp(econt, new Error("unbound variable '" + symbol + "'"));
};

var binary_ops = {
    '+': function (a, b) { return a + b; }
};


function literal(node, env, cont, econt) {
    return tramp(cont, node.value);
}

var evaluate_type = {
    NumericLiteral: literal,
    StringLiteral: literal,

    Program: function (node, env, cont, econt) {
        return env.evaluateStatements(node.elements, cont, econt);
    },

    BinaryExpression: function (node, env, cont, econt) {
        return env.evaluate(node.left, function (a) {
            return env.evaluate(node.right, function (b) {
                return tramp(cont, binary_ops[node.operator](a, b));
            }, econt);
        }, econt);
    },

    Variable: function (node, env, cont, econt) {
        return env.lookup(node.name, cont, econt);
    },

    VariableStatement: function (node, env, cont, econt) {
        var decls = node.declarations;

        function do_decls(i) {
            for (;;) {
                if (i == decls.length)
                    return tramp(cont, undefined);

                var decl = decls[i];
                if (decl.value)
                    break;

                env.bind(decl.name, undefined);
                i++;
            }

            return env.evaluate(decl.value, function (val) {
                env.bind(decl.name, val);
                return do_decls(i + 1);
            }, econt);
        }

        return do_decls(0);
    },

    FunctionCall: function (node, env, cont, econt) {
        return env.evaluate(node.name, function (f) {
            var args = node.arguments;
            var evaled_args = [];

            function do_args(i) {
                if (i == args.length)
                    return f.call(null, evaled_args, cont, econt);

                return env.evaluate(args[i], function (a) {
                    evaled_args.push(a);
                    return do_args(i + 1);
                }, econt);
            }

            return do_args(0);
        }, econt);
    },

    Function: function (node, env, cont, econt) {
        return tramp(cont, function (args, cont, econt) {
            var subenv = new Environment(env);
            for (var i = 0; i < node.params.length; i++)
                subenv.bind(node.params[i], args[i]);

            return subenv.evaluateStatements(node.elements, cont, econt);
        });
    },

    TryStatement: function (node, env, cont, econt) {
        return env.evaluateStatements(node.block.statements, cont, function (err) {
            var katch = node['catch'];
            var subenv = new Environment(env);
            subenv.bind(katch.identifier, err);
            return subenv.evaluateStatements(katch.block.statements, cont, econt);
        });
    },

    ThrowStatement: function (node, env, cont, econt) {
        return env.evaluate(node.exception, econt, econt);
    },

    AssignmentExpression: function (node, env, cont, econt) {
        return env.evaluate(node.right, function (val) {
            return env.assign(node.left.name, val, cont, econt);
        }, econt);
    },

    PropertyAccess: function (node, env, cont, econt) {
        return env.evaluate(node.base, function (val) {
            return tramp(cont, val[node.name]);
        });
    },
};

Environment.prototype.evaluate = function (node, cont, econt) {
    var handler = evaluate_type[node.type];
    if (handler)
        return handler(node, this, cont, econt);
    else
        return econt(new Error(node.type + " not yet implemented"));
};

Environment.prototype.evaluateStatements = function (stmts, cont, econt) {
    var env = this;

    function do_elements(i, last) {
        if (i == stmts.length)
            return tramp(cont, last);

        return env.evaluate(stmts[i], function (last) {
            return do_elements(i + 1, last);
        }, econt);
    }

    return do_elements(0, undefined);
};

function tramp(cont, val) {
    return { cont: cont, val: val };
}

function oline(t) {
    while (t)
        t = t.cont(t.val);
}

Environment.prototype.run = function (p, cont, econt) {
    try {
        p = parser.parse(p);
        //console.log(JSON.stringify(p, null, "  "));
    }
    catch (e) {
        econt(e);
        return;
    }

    oline(this.evaluate(p, function (val) {
        cont(val);
    }, function (err) {
        econt(err);
    }));
};

function lift_function(f) {
    return function (args, cont, econt) {
        try {
            return tramp(cont, f.apply(null, args));
        }
        catch (e) {
            return tramp(econt, e);
        }
    };
}

function lift_promised_function(f) {
    return function (args, cont, econt) {
        try {
            f.apply(null, args).then(function (val) {
                oline(cont(val));
            }, function (err) {
                oline(econt(err));
            });
        }
        catch (e) {
            return tramp(econt, e);
        }
    };
}

var builtins = new Environment();
builtins.bind('a', 100);
builtins.bind('print', lift_function(function (x) { console.log(x); }));

builtins.bind('callcc', function (args, cont, econt) {
    // Call the provided continuation recipeint with a single argument...
    return args[0].call(null, [function (args2, cont2, econt2) {
        // ... that takes a single argument and calls the original
        // continuation with it.
        return tramp(cont, args2[0]);
    }], cont, econt);
});


function run(p) {
    builtins.run(p,
                 function (val) { console.log("=> " + val); },
                 function (err) { console.log("=! " + err); });
}

//run("try { (function (n) { var x = n+1; print(x); throw 'bang'; 42; })(69); } catch (e) { print('oops: ' + e); 69; }");
//var code = "var x; callcc(function (c) { x = c; }); print('Hello'); x();"
//var code = "print(a+42)";

module.exports.builtins = builtins;
module.exports.Environment = Environment;
module.exports.lift_function = lift_function;
module.exports.lift_promised_function = lift_promised_function;