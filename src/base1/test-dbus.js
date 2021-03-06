/* global $, cockpit, QUnit, common_dbus_tests, dbus_track_tests */

/* To help with future migration */
var assert = QUnit;

/* with a name */
var options = {
    "bus": "session"
};
common_dbus_tests(options, "com.redhat.Cockpit.DBusTests.Test");
dbus_track_tests(options, "com.redhat.Cockpit.DBusTests.Test");

QUnit.test("proxy no stutter", function() {
    var dbus = cockpit.dbus("com.redhat.Cockpit.DBusTests.Test", { "bus": "session" });

    var proxy = dbus.proxy();
    assert.equal(proxy.iface, "com.redhat.Cockpit.DBusTests.Test", "interface auto chosen");
    assert.equal(proxy.path, "/com/redhat/Cockpit/DBusTests/Test", "path auto chosen");
});

QUnit.test("proxies no stutter", function() {
    var dbus = cockpit.dbus("com.redhat.Cockpit.DBusTests.Test", { "bus": "session" });

    var proxies = dbus.proxies();
    assert.equal(proxies.iface, "com.redhat.Cockpit.DBusTests.Test", "interface auto chosen");
    assert.equal(proxies.path_namespace, "/", "path auto chosen");
});

QUnit.test("exposed client and options", function() {
    var options = { host: "localhost", "bus": "session" };
    var dbus = cockpit.dbus("com.redhat.Cockpit.DBusTests.Test", options);
    var proxy = dbus.proxy("com.redhat.Cockpit.DBusTests.Frobber", "/otree/frobber");
    var proxies = dbus.proxies("com.redhat.Cockpit.DBusTests.Frobber");

    assert.deepEqual(dbus.options, options, "client object exposes options");
    assert.strictEqual(proxy.client, dbus, "proxy object exposes client");
    assert.strictEqual(proxies.client, dbus, "proxies object exposes client");
});

QUnit.test("subscriptions on closed client", function() {
    function on_signal() {
    }

    var dbus = cockpit.dbus("com.redhat.Cockpit.DBusTests.Test", { "bus": "session" });
    dbus.close();

    var subscription = dbus.subscribe({
        "interface": "com.redhat.Cockpit.DBusTests.Frobber",
        "path": "/otree/frobber"
    }, on_signal);
    assert.ok(subscription, "can subscribe");

    subscription.remove();
    assert.ok(true, "can unsubscribe");
});

QUnit.test("watch promise recursive", function() {
    assert.expect(7);

    var dbus = cockpit.dbus("com.redhat.Cockpit.DBusTests.Test", { "bus": "session" });
    var promise = dbus.watch("/otree/frobber");

    var target = { };
    var promise2 = promise.promise(target);
    assert.strictEqual(promise2, target, "used target");
    assert.equal(typeof promise2.done, "function", "promise2.done()");
    assert.equal(typeof promise2.promise, "function", "promise2.promise()");
    assert.equal(typeof promise2.remove, "function", "promise2.remove()");

    var promise3 = promise2.promise();
    assert.equal(typeof promise3.done, "function", "promise3.done()");
    assert.equal(typeof promise3.promise, "function", "promise3.promise()");
    assert.equal(typeof promise3.remove, "function", "promise3.remove()");
});

QUnit.asyncTest("owned messages", function() {
    assert.expect(9);

    var name = "yo.x" + new Date().getTime();
    var times_changed = 0;

    var dbus = cockpit.dbus("com.redhat.Cockpit.DBusTests.Test", { "bus": "session" });
    var other = null;
    var org_owner = null;
    function on_owner (event, owner) {
        if (times_changed === 0) {
            assert.strictEqual(typeof owner, "string", "intial owner string");
            assert.ok(owner.length > 1, "intial owner not empty");
            org_owner = owner;
        } else if (times_changed === 1) {
            assert.strictEqual(owner, null, "no owner");
        } else if (times_changed === 2) {
            // owner is the same because the server
            // dbus connection is too.
            assert.strictEqual(owner, org_owner, "has owner again");
        }
        times_changed++;
    }

    function acquire_name () {
        dbus.call("/otree/frobber", "com.redhat.Cockpit.DBusTests.Frobber",
                  "ClaimOtherName", [ name ])
            .always(function() {
                assert.equal(this.state(), "resolved", "name claimed");
                if (!other) {
                    other = cockpit.dbus(name, { "bus": "session" });
                    $(other).on("owner", on_owner);
                    release_name();
                } else {
                    assert.strictEqual(times_changed, 3, "owner changed three times");
                    QUnit.start();
                }
            });
    }

    function release_name () {
        other.call("/otree/frobber", "com.redhat.Cockpit.DBusTests.Frobber",
                        "HelloWorld", [ "test" ])
                  .always(function() {
                        assert.equal(this.state(), "resolved", "called on other name");

                        dbus.call("/otree/frobber", "com.redhat.Cockpit.DBusTests.Frobber",
                                  "ReleaseOtherName", [ name ])
                            .always(function() {
                                assert.equal(this.state(), "resolved", "name released");
                                acquire_name();
                            });
                  });
    }
    acquire_name();
});

QUnit.asyncTest("bad dbus address", function() {
    assert.expect(1);

    var dbus = cockpit.dbus(null, { "bus": "none", "address": "bad" });
    $(dbus).on("close", function(event, options) {
        assert.equal(options.problem, "protocol-error", "bad address closed");
        QUnit.start();
    });
});

QUnit.asyncTest("bad dbus bus", function() {
    assert.expect(1);

    var dbus = cockpit.dbus(null, { "bus": "bad" });
    $(dbus).on("close", function(event, options) {
        assert.equal(options.problem, "protocol-error", "bad bus format");
        QUnit.start();
    });
});

function internal_test(options) {
    assert.expect(2);
    var dbus = cockpit.dbus(null, options);
    dbus.call("/", "org.freedesktop.DBus.Introspectable", "Introspect")
        .done(function(resp) {
            assert.ok(String(resp[0]).indexOf("<node") !== -1, "introspected internal");
        })
        .always(function() {
            assert.equal(this.state(), "resolved", "called internal");
            QUnit.start();
        });
}

QUnit.asyncTest("internal dbus", function() {
    internal_test({"bus": "internal"});
});

QUnit.asyncTest("internal dbus bus none", function() {
    internal_test({"bus": "none"});
});

QUnit.asyncTest("internal dbus bus none with address", function() {
    internal_test({"bus": "none", "address": "internal"});
});

QUnit.start();
