/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2015 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

(function() {
    "use strict";

    var $ = require("jquery");
    var cockpit = require("cockpit");

    var mustache = require("mustache");
    var journal = require("journal");

    var utils = require("./utils");
    var dialog = require("./dialog");
    var permissions = require("./permissions");

    var _ = cockpit.gettext;
    var C_ = cockpit.gettext;

    /* DETAILS
     */

    function init_details(client, jobs) {
        var type, name;

        var multipathd_service = utils.get_multipathd_service();

        function get_children(path) {
            var children = [ ];

            if (client.blocks_cleartext[path]) {
                children.push(client.blocks_cleartext[path].path);
            }

            if (client.blocks_ptable[path]) {
                client.blocks_partitions[path].forEach(function (part) {
                    if (!part.IsContainer)
                        children.push(part.path);
                });
            }

            if (client.blocks_part[path] && client.blocks_part[path].IsContainer) {
                var ptable_path = client.blocks_part[path].Table;
                client.blocks_partitions[ptable_path].forEach(function (part) {
                    if (part.IsContained)
                        children.push(part.path);
                });
            }

            if (client.vgroups[path]) {
                client.vgroups_lvols[path].forEach(function (lvol) {
                    if (client.lvols_block[lvol.path])
                        children.push(client.lvols_block[lvol.path].path);
                });
            }

            return children;
        }

        function get_usage_alerts(path) {
            var block = client.blocks[path];
            var fsys = client.blocks_fsys[path];
            var pvol = client.blocks_pvol[path];

            var usage = utils.flatten(get_children(path).map(get_usage_alerts));

            if (fsys && fsys.MountPoints.length > 0)
                usage.push({ usage: 'mounted',
                             Message: cockpit.format(_("Device $0 is mounted on $1"),
                                                     utils.block_name(block),
                                                     utils.decode_filename(fsys.MountPoints[0]))
                           });
            if (block && client.mdraids[block.MDRaidMember])
                usage.push({ usage: 'mdraid-member',
                             Message: cockpit.format(_("Device $0 is a member of RAID Array $1"),
                                                     utils.block_name(block),
                                                     utils.mdraid_name(client.mdraids[block.MDRaidMember]))
                           });
            if (pvol && client.vgroups[pvol.VolumeGroup])
                usage.push({ usage: 'pvol',
                             Message: cockpit.format(_("Device $0 is a physical volume of $1"),
                                                     utils.block_name(block),
                                                     client.vgroups[pvol.VolumeGroup].Name)
                           });

            return usage;
        }

        function format_dialog(path, start, size, enable_dos_extended) {
            var block = client.blocks[path];
            var block_ptable = client.blocks_ptable[path];

            var create_partition = (start !== undefined);

            var title;
            if (create_partition)
                title = cockpit.format(_("Create partition on $0"), utils.block_name(block));
            else
                title = cockpit.format(_("Format $0"), utils.block_name(block));

            function is_encrypted(vals) {
                return vals.type == "luks+xfs" || vals.type == "luks+ext4";
            }

            function is_filesystem(vals) {
                return vals.type != "empty" && vals.type != "dos-extended";
            }

            /* Older UDisks2 implementations don't have good enough
             * support for maintaining fstab and crypptab, so we don't
             * offer that in the UI.  (Most importantly, they miss the
             * 'tear-down' option and without that we'll end up with
             * obsolete fstab files all the time, which will break the
             * next boot.)
             */

            function is_encrypted_and_not_old_udisks2(vals) {
                return !client.is_old_udisks2 && is_encrypted(vals);
            }

            function is_filesystem_and_not_old_udisks2(vals) {
                return !client.is_old_udisks2 && is_filesystem(vals);
            }

            function add_fsys(storaged_name, entry) {
                if (storaged_name === true ||
                    !client.manager.SupportedFilesystems ||
                    client.manager.SupportedFilesystems.indexOf(storaged_name) != -1)
                    filesystem_options.push(entry);
            }

            /* Older UDisks2 implementations don't have
             * CreateAndFormatPartition, so we simulate that.
             */

            function create_partition_and_format(ptable,
                                                 start, size,
                                                 part_type, part_name, part_options,
                                                 type, options) {
                if (!client.is_old_udisks2)
                    return ptable.CreatePartitionAndFormat(start, size,
                                                           part_type, part_name, part_options,
                                                           type, options);

                return ptable.CreatePartition(start, size, part_type, part_name, part_options)
                    .then(function(partition) {
                        // We don't use client.blocks[partition] here
                        // because it might not be defined.  In that
                        // case, we prefer storaged to tell us in a
                        // D-Bus error instead of causing a JavaScript
                        // exception.
                        //
                        // See https://github.com/cockpit-project/cockpit/issues/4181
                        return client.call(partition, "Block", "Format", [ type, options ]).then(function() {
                            return partition;
                        });
                    });
            }

            var filesystem_options = [ ];
            add_fsys("xfs",  { value: "xfs", Title: _("XFS - Red Hat Enterprise Linux 7 default") });
            add_fsys("ext4", { value: "ext4", Title: _("ext4 - Red Hat Enterprise Linux 6 default") });
            add_fsys("xfs",  { value: "luks+xfs", Title: _("Encrypted XFS (LUKS)") });
            add_fsys("ext4", { value: "luks+ext4", Title: _("Encrypted EXT4 (LUKS)") });
            add_fsys("vfat", { value: "vfat", Title: _("VFAT - Compatible with all systems and devices") });
            add_fsys("ntfs", { value: "ntfs", Title: _("NTFS - Compatible with most systems") });
            add_fsys(true, { value: "dos-extended", Title: _("Extended Partition"),
                             disabled: !(create_partition && enable_dos_extended) });
            add_fsys(true, { value: "empty", Title: _("No Filesystem") });
            add_fsys(true, { value: "custom", Title: _("Custom (Enter filesystem type)") });

            dialog.open({ Title: title,
                          Alerts: get_usage_alerts(path),
                          Fields: [
                              { SizeSlider: "size",
                                Title: _("Size"),
                                Value: size,
                                Max: size,
                                visible: function () {
                                    return create_partition;
                                }
                              },
                              { SelectOne: "erase",
                                Title: _("Erase"),
                                Options: [
                                    { value: "no", Title: _("Don't overwrite existing data") },
                                    { value: "zero", Title: _("Overwrite existing data with zeros") }
                                ]
                              },
                              { SelectOne: "type",
                                Title: _("Type"),
                                Options: filesystem_options
                              },
                              { TextInput: "name",
                                Title: _("Name"),
                                visible: is_filesystem
                              },
                              { TextInput: "custom",
                                Title: _("Filesystem type"),
                                visible: function (vals) {
                                    return vals.type == "custom";
                                }
                              },
                              { PassInput: "passphrase",
                                Title: _("Passphrase"),
                                validate: function (phrase) {
                                    if (phrase === "")
                                        return _("Passphrase cannot be empty");
                                },
                                visible: is_encrypted
                              },
                              { PassInput: "passphrase2",
                                Title: _("Confirm passphrase"),
                                validate: function (phrase2, vals) {
                                    if (phrase2 != vals.passphrase)
                                        return _("Passphrases do not match");
                                },
                                visible: is_encrypted
                              },
                              { CheckBox: "store_passphrase",
                                Title: _("Store passphrase"),
                                visible: is_encrypted_and_not_old_udisks2
                              },
                              { TextInput: "crypto_options",
                                Title: _("Encryption Options"),
                                visible: is_encrypted_and_not_old_udisks2
                              },
                              { SelectOne: "mounting",
                                Title: _("Mounting"),
                                Options: [
                                    { value: "default", Title: _("Default") },
                                    { value: "custom", Title: _("Custom") }
                                ],
                                visible: is_filesystem_and_not_old_udisks2
                              },
                              { TextInput: "mount_point",
                                Title: _("Mount Point"),
                                visible: function (vals) {
                                    return is_filesystem_and_not_old_udisks2(vals) && vals.mounting == "custom";
                                }
                              },
                              { TextInput: "mount_options",
                                Title: _("Mount Options"),
                                visible: function (vals) {
                                    return is_filesystem_and_not_old_udisks2(vals) && vals.mounting == "custom";
                                }
                              }
                          ],
                          Action: {
                              Title: create_partition? _("Create partition") : _("Format"),
                              Danger: (create_partition?
                                       null : _("Formatting a storage device will erase all data on it.")),
                              action: function (vals) {
                                  if (vals.type == "custom")
                                      vals.type = vals.custom;

                                  var options = { 'no-block': { t: 'b', v: true },
                                                  'dry-run-first': { t: 'b', v: true },
                                                  'tear-down': { t: 'b', v: true }
                                                };
                                  if (vals.erase != "no")
                                      options.erase = { t: 's', v: vals.erase };
                                  if (vals.name)
                                      options.label = { t: 's', v: vals.name };

                                  var config_items = [ ];
                                  if (vals.mounting == "custom")
                                      config_items.push([
                                          "fstab", {
                                              dir: { t: 'ay', v: utils.encode_filename(vals.mount_point) },
                                              type: { t: 'ay', v: utils.encode_filename("auto") },
                                              opts: { t: 'ay', v: utils.encode_filename(vals.mount_options || "defaults") },
                                              freq: { t: 'i', v: 0 },
                                              passno: { t: 'i', v: 0 },
                                              "track-parents": { t: 'b', v: true }
                                          }]);

                                  if (is_encrypted(vals)) {
                                      vals.type = vals.type.replace("luks+", "");
                                      options["encrypt.passphrase"] = { t: 's', v: vals.passphrase };

                                      var item = {
                                          options: { t: 'ay', v: utils.encode_filename(vals.crypto_options) },
                                          "track-parents": { t: 'b', v: true }
                                      };
                                      if (vals.store_passphrase) {
                                          item["passphrase-contents"] =
                                              { t: 'ay', v: utils.encode_filename(vals.passphrase) };
                                      } else {
                                          item["passphrase-contents"] =
                                              { t: 'ay', v: utils.encode_filename("") };
                                      }
                                      config_items.push([ "crypttab", item ]);
                                  }

                                  if (config_items.length > 0)
                                      options["config-items"] = { t: 'a(sa{sv})', v: config_items };

                                  if (create_partition) {
                                      if (vals.type == "dos-extended")
                                          return block_ptable.CreatePartition(start, vals.size, "0x05", "", { });
                                      else if (vals.type == "empty")
                                          return block_ptable.CreatePartition(start, vals.size, "", "", { });
                                      else
                                          return create_partition_and_format(block_ptable, start, vals.size,
                                                                             "", "", { },
                                                                             vals.type, options);
                                  } else
                                      return block.Format(vals.type, options);
                              }
                          }
                        });
        }

        var actions = {
            format_disk: function format_disk(path) {
                var block = client.blocks[path];

                dialog.open({ Title: cockpit.format(_("Format Disk $0"), utils.block_name(block)),
                              Alerts: get_usage_alerts(path),
                              Fields: [
                                  { SelectOne: "erase",
                                    Title: _("Erase"),
                                    Options: [
                                        { value: "no", Title: _("Don't overwrite existing data") },
                                        { value: "zero", Title: _("Overwrite existing data with zeros") }
                                    ]
                                  },
                                  { SelectOne: "type",
                                    Title: _("Partitioning"),
                                    Options: [
                                        { value: "dos", Title: _("Compatible with all systems and devices (MBR)") },
                                        { value: "gpt", Title: _("Compatible with modern system and hard disks > 2TB (GPT)"),
                                          selected: true
                                        },
                                        { value: "empty", Title: _("No partitioning") }
                                    ]
                                  }
                              ],
                              Action: {
                                  Title: _("Format"),
                                  Danger: _("Formatting a disk will erase all data on it."),
                                  action: function (vals) {
                                      var options = { 'no-block': { t: 'b', v: true },
                                                      'tear-down': { t: 'b', v: true }
                                                    };
                                      if (vals.erase != "no")
                                          options.erase = { t: 's', v: vals.erase };
                                      return block.Format(vals.type, options);
                                  }
                              }
                            });
            },

            create_partition: function create_partition (path, start, size, enable_dos_extended) {
                format_dialog(path, start, size, enable_dos_extended);
            },

            mount: function mount(path) {
                return client.blocks_fsys[path].Mount({});
            },
            unmount: function unmount(path) {
                return client.blocks_fsys[path].Unmount({});
            },
            fsys_options: function fsys_options(path) {
                var block = client.blocks[path];
                var fsys = client.blocks_fsys[path];
                var old_config = null;
                var old_dir, old_opts;

                if (!block || !fsys)
                    return;

                old_config = utils.array_find(block.Configuration, function (c) { return c[0] == "fstab"; });
                if (old_config) {
                    old_dir = utils.decode_filename(old_config[1].dir.v);
                    old_opts = (utils.decode_filename(old_config[1].opts.v).
                                split(",").
                                filter(function (s) { return s.indexOf("x-parent") !== 0; }).
                                join(","));
                }

                function maybe_change_name(new_name) {
                    if (new_name != block.IdLabel)
                        return fsys.SetLabel(new_name, {});
                }

                function maybe_update_config(new_is_custom, new_dir, new_opts) {
                    var new_config = null;
                    if (new_is_custom) {
                        new_config = [
                            "fstab", {
                                dir: { t: 'ay', v: utils.encode_filename(new_dir) },
                                type: { t: 'ay', v: utils.encode_filename("auto") },
                                opts: { t: 'ay', v: utils.encode_filename(new_opts || "defaults") },
                                freq: { t: 'i', v: 0 },
                                passno: { t: 'i', v: 0 },
                                "track-parents": { t: 'b', v: true }
                            }];
                    }

                    if (!old_config && new_config)
                        return block.AddConfigurationItem(new_config, {});
                    else if (old_config && !new_config)
                        return block.RemoveConfigurationItem(old_config, {});
                    else if (old_config && new_config && (new_dir != old_dir || new_opts != old_opts))
                        return block.UpdateConfigurationItem(old_config, new_config, {});
                }

                dialog.open({ Title: _("Filesystem Options"),
                              Fields: [
                                  { TextInput: "name",
                                    Title: _("Name"),
                                    Value: block.IdLabel
                                  },
                                  { SelectOne: "mounting",
                                    Title: _("Mounting"),
                                    Options: [
                                        { value: "default", Title: _("Default"), selected: !old_config },
                                        { value: "custom", Title: _("Custom"), selected: !!old_config }
                                    ],
                                  },
                                  { TextInput: "mount_point",
                                    Title: _("Mount Point"),
                                    Value: old_dir,
                                    visible: function (vals) {
                                        return vals.mounting == "custom";
                                    }
                                  },
                                  { TextInput: "mount_options",
                                    Title: _("Mount Options"),
                                    Value: old_opts,
                                    visible: function (vals) {
                                        return vals.mounting == "custom";
                                    }
                                  }
                              ],
                              Action: {
                                  Title: _("Apply"),
                                  action: function (vals) {
                                      return cockpit.all(maybe_change_name(vals.name),
                                                         maybe_update_config(vals.mounting == "custom",
                                                                        vals.mount_point, vals.mount_options));
                                  }
                              }
                            });
            },

            lock: function lock(path) {
                return client.blocks_crypto[path].Lock({});
            },
            unlock: function unlock(path) {
                var crypto = client.blocks_crypto[path];
                if (!crypto)
                    return;

                dialog.open({ Title: _("Unlock"),
                              Fields: [
                                  { PassInput: "passphrase",
                                    Title: _("Passphrase")
                                  }
                              ],
                              Action: {
                                  Title: _("Unlock"),
                                  action: function (vals) {
                                      return crypto.Unlock(vals.passphrase, {});
                                  }
                              }
                            });
            },
            crypto_options: function crypto_options(path) {
                var block = client.blocks[path];
                var old_config = null;
                var old_passphrase, old_options;

                if (!block)
                    return;

                block.GetSecretConfiguration({}).done(
                    function (items) {
                        old_config = utils.array_find(items, function (c) { return c[0] == "crypttab"; });
                        if (old_config) {
                            if (old_config[1]['passphrase-contents'])
                                old_passphrase = utils.decode_filename(old_config[1]['passphrase-contents'].v);
                            old_options = (utils.decode_filename(old_config[1].options.v).
                                           split(",").
                                           filter(function (s) { return s.indexOf("x-parent") !== 0; }).
                                           join(","));
                        }

                        function maybe_change_config(new_passphrase, new_options) {
                            if (new_passphrase != old_passphrase || new_options != old_options) {
                                var new_config =
                                    [ "crypttab",
                                      {
                                          options: { t: 'ay', v: utils.encode_filename(new_options) },
                                          "track-parents": { t: 'b', v: true },
                                          "passphrase-contents": { t: 'ay', v: utils.encode_filename(new_passphrase) }
                                      }
                                    ];
                                if (old_config)
                                    return block.UpdateConfigurationItem(old_config, new_config, { });
                                else
                                    return block.AddConfigurationItem(new_config, { });
                            }
                        }

                        dialog.open({ Title: _("Encryption Options"),
                                      Fields: [
                                          { PassInput: "passphrase",
                                            Title: _("Stored Passphrase"),
                                            Value: old_passphrase,
                                          },
                                          { TextInput: "options",
                                            Title: _("Options"),
                                            Value: old_options,
                                          }
                                      ],
                                      Action: {
                                          Title: _("Apply"),
                                          action: function (vals) {
                                              return maybe_change_config(vals.passphrase, vals.options);
                                          }
                                      }
                                    });
                    });
            },

            mdraid_start: function mdraid_start(path) {
                return client.mdraids[path].Start({ "start-degraded": { t: 'b', v: true } });
            },
            mdraid_stop: function mdraid_stop(path) {
                return client.mdraids[path].Stop({});
            },
            mdraid_start_scrub: function mdraid_start_scrub(path) {
                return client.mdraids[path].RequestSyncAction("repair", {});
            },
            mdraid_stop_scrub: function mdraid_stop_scrub(path) {
                return client.mdraids[path].RequestSyncAction("idle", {});
            },
            mdraid_toggle_bitmap: function mdraid_toggle_bitmap(path) {
                var old = utils.decode_filename(client.mdraids[path].BitmapLocation);
                return client.mdraids[path].SetBitmapLocation(utils.encode_filename(old == 'none'? 'internal' : 'none'), {});
            },
            mdraid_add_disk: function mdraid_add_disk(path) {
                var mdraid = client.mdraids[path];

                dialog.open({ Title: _("Add Disks"),
                              Fields: [
                                  { SelectMany: "disks",
                                    Title: _("Disks"),
                                    Options: (utils.get_free_blockdevs(client).
                                              filter(function (b) {
                                                  if (client.blocks_part[b.path])
                                                      b = client.blocks[client.blocks_part[b.path].Table];
                                                  return b && client.blocks[b.path].MDRaid != path;
                                              }).
                                              map(function (b) {
                                                  return { value: b.path, Title: b.Name + " " + b.Description };
                                              })),
                                    validate: function (disks) {
                                        if (disks.length === 0)
                                            return _("At least one disk is needed.");
                                    }
                                  }
                              ],
                              Action: {
                                  Title: _("Add"),
                                  action: function (vals) {
                                      return cockpit.all(vals.disks.map(function (p) {
                                          return mdraid.AddDevice(p, {});
                                      }));
                                  }
                              }
                            });
            },
            mdraid_remove_disk: function mdraid_remove_disk(path) {
                var block = client.blocks[path];
                var mdraid = client.mdraids[block.MDRaidMember];
                return mdraid.RemoveDevice(path, { wipe: { t: 'b', v: true } });
            },
            mdraid_delete: function mdraid_delete(path) {
                var location = cockpit.location;
                var mdraid = client.mdraids[path];
                if (!mdraid)
                    return;

                function delete_() {
                    if (mdraid.Delete)
                        return mdraid.Delete({ 'tear-down': { t: 'b', v: true } });

                    // If we don't have a Delete method, we simulate
                    // it by stopping the array and wiping all
                    // members.

                    function wipe_members() {
                        return cockpit.all(client.mdraids_members[path].map(function (member) {
                            return member.Format('empty', { });
                        }));
                    }

                    if (mdraid.ActiveDevices && mdraid.ActiveDevices.length > 0)
                        return mdraid.Stop({}).then(wipe_members);
                    else
                        return wipe_members();
                }

                var block = client.mdraids_block[path];
                dialog.open({ Title: cockpit.format(_("Please confirm deletion of $0"),
                                                    utils.mdraid_name(mdraid)),
                              Alerts: block && get_usage_alerts(block.path),
                              Fields: [ ],
                              Action: {
                                  Title: _("Delete"),
                                  Danger: _("Deleting a RAID device will erase all data on it."),
                                  action: function (vals) {
                                      return delete_().
                                              done(function () {
                                                  location.go('/');
                                              });
                                  }
                              }
                            });
            },

            resize: function resize(path) {
                var lvol = client.lvols[path];
                if (!lvol)
                    return;

                var block = client.lvols_block[path];
                var vgroup = client.vgroups[lvol.VolumeGroup];
                var pool = client.lvols[lvol.ThinPool];

                /* Resizing is only safe when lvol has a filesystem
                   and that filesystem is resized at the same time.

                   So we always resize the filesystem for lvols that
                   have one, and refuse to shrink otherwise.

                   Note that shrinking a filesystem will not always
                   succeed, but it is never dangerous.
                */

                dialog.open({ Title: _("Resize Logical Volume"),
                              Fields: [
                                  { SizeSlider: "size",
                                    Title: _("Size"),
                                    Value: lvol.Size,
                                    Max: (pool ?
                                          pool.Size * 3 :
                                          lvol.Size + vgroup.FreeSize),
                                    AllowInfinite: !!pool,
                                    Round: vgroup.ExtentSize
                                  },
                                  { CheckBox: "fsys",
                                    Title: _("Resize Filesystem"),
                                    Value: block && block.IdUsage == "filesystem",
                                    visible: function () {
                                        return lvol.Type == "block";
                                    }
                                  }
                              ],
                              Action: {
                                  Title: _("Resize"),
                                  action: function (vals) {

                                      function error(msg) {
                                          return $.Deferred().reject({ message: msg }).promise();
                                      }

                                      var fsys = (block && block.IdUsage == "filesystem");
                                      if (!fsys && vals.size < lvol.Size)
                                          return error(_("This logical volume cannot be made smaller."));

                                      var options = { };
                                      if (fsys)
                                          options.resize_fsys = { t: 'b', v: fsys };

                                      return lvol.Resize(vals.size, options);
                                  }
                              }
                            });
            },
            rename: function rename(path) {
                var lvol = client.lvols[path];
                if (!lvol)
                    return;

                dialog.open({ Title: _("Renamee Logical Volume"),
                              Fields: [
                                  { TextInput: "name",
                                    Title: _("Name"),
                                    Value: lvol.Name
                                  }
                              ],
                              Action: {
                                  Title: _("Rename"),
                                  action: function (vals) {
                                      return lvol.Rename(vals.name, { });
                                  }
                              }
                            });
            },
            create_snapshot: function create_snapshot(path) {
                var lvol = client.lvols[path];
                if (!lvol)
                    return;

                var vgroup = client.vgroups[lvol.VolumeGroup];

                dialog.open({ Title: _("Create Snapshot"),
                              Fields: [
                                  { TextInput: "name",
                                    Title: _("Name"),
                                    validate: utils.validate_lvm2_name
                                  },
                                  { SizeSlider: "size",
                                    Title: _("Size"),
                                    Value: lvol.Size * 0.2,
                                    Max: lvol.Size,
                                    Round: vgroup.ExtentSize,
                                    visible: function () {
                                        return lvol.ThinPool == "/";
                                    }
                                  }
                              ],
                              Action: {
                                  Title: _("Create"),
                                  action: function (vals) {
                                      return lvol.CreateSnapshot(vals.name, vals.size || 0, { });
                                  }
                              }
                            });
            },
            activate: function activate(path) {
                if (client.lvols[path])
                    return client.lvols[path].Activate({});
            },
            deactivate: function deactivate(path) {
                if (client.lvols[path])
                    return client.lvols[path].Deactivate({});
            },
            create_thin: function create_thin(path) {
                var pool = client.lvols[path];
                var vgroup = pool && client.vgroups[pool.VolumeGroup];
                if (!pool || !vgroup)
                    return;

                dialog.open({ Title: _("Create Thin Volume"),
                              Fields: [
                                  { TextInput: "name",
                                    Title: _("Name"),
                                    validate: utils.validate_lvm2_name
                                  },
                                  { SizeSlider: "size",
                                    Title: _("Size"),
                                    Value: pool.Size,
                                    Max: pool.Size * 3,
                                    AllowInfinite: true,
                                    Round: vgroup.ExtentSize
                                  }
                              ],
                              Action: {
                                  Title: _("Create"),
                                  action: function (vals) {
                                      return vgroup.CreateThinVolume(vals.name, vals.size, pool.path, { });
                                  }
                              }
                            });
            },

            vgroup_rename: function vgroup_rename(path) {
                var location = cockpit.location;
                var vgroup = client.vgroups[path];
                if (!vgroup)
                    return;

                dialog.open({ Title: _("Rename Volume Group"),
                              Fields: [
                                  { TextInput: "name",
                                    Title: _("Name"),
                                    Value: vgroup.Name,
                                    validate: utils.validate_lvm2_name
                                  },
                              ],
                              Action: {
                                  Title: _("Create"),
                                  action: function (vals) {
                                      return vgroup.Rename(vals.name, { }).
                                          done(function () {
                                              location.go([ 'vg', vals.name ]);
                                          });
                                  }
                              }
                            });

            },
            vgroup_delete: function vgroup_delete(path) {
                var location = cockpit.location;
                var vgroup = client.vgroups[path];
                if (!vgroup)
                    return;

                dialog.open({ Title: cockpit.format(_("Please confirm deletion of $0"), vgroup.Name),
                              Alerts: get_usage_alerts(path),
                              Fields: [
                              ],
                              Action: {
                                  Danger: _("Deleting a volume group will erase all data on it."),
                                  Title: _("Delete"),
                                  action: function () {
                                      return vgroup.Delete(true,
                                                           { 'tear-down': { t: 'b', v: true }
                                                           }).
                                          done(function () {
                                              location.go('/');
                                          });
                                  }
                              }
                            });
            },

            vgroup_create_lvol: function vgroup_create_lvol(path) {
                var vgroup = client.vgroups[path];
                if (!vgroup)
                    return;

                function find_lvol(name) {
                    var lvols = client.vgroups_lvols[path];
                    for (var i = 0; i < lvols.length; i++) {
                        if (lvols[i].Name == name)
                            return lvols[i];
                    }
                    return null;
                }

                var name;
                for (var i = 0; i < 1000; i++) {
                    name = "lvol" + i.toFixed();
                    if (!find_lvol(name))
                        break;
                }

                dialog.open({ Title: _("Create Logical Volume"),
                              Fields: [
                                  { TextInput: "name",
                                    Title: _("Name"),
                                    Value: name,
                                    validate: utils.validate_lvm2_name
                                  },
                                  { SelectOne: "purpose",
                                    Title: _("Purpose"),
                                    Options: [
                                        { value: "block", Title: _("Block device for filesystems"),
                                          selected: true
                                        },
                                        { value: "pool", Title: _("Pool for thinly provisioned volumes") }
                                        /* Not implemented
                                           { value: "cache", Title: _("Cache") }
                                        */
                                    ]
                                  },
                                  /* Not Implemented
                                  { SelectOne: "layout",
                                    Title: _("Layout"),
                                    Options: [
                                        { value: "linear", Title: _("Linear"),
                                          selected: true
                                        },
                                        { value: "striped", Title: _("Striped (RAID 0)"),
                                          enabled: raid_is_possible
                                        },
                                        { value: "raid1", Title: _("Mirrored (RAID 1)"),
                                          enabled: raid_is_possible
                                        },
                                        { value: "raid10", Title: _("Striped and mirrored (RAID 10)"),
                                          enabled: raid_is_possible
                                        },
                                        { value: "raid4", Title: _("With dedicated parity (RAID 4)"),
                                          enabled: raid_is_possible
                                        },
                                        { value: "raid5", Title: _("With distributed parity (RAID 5)"),
                                          enabled: raid_is_possible
                                        },
                                        { value: "raid6", Title: _("With double distributed parity (RAID 6)"),
                                          enabled: raid_is_possible
                                        }
                                    ],
                                  },
                                  */
                                  { SizeSlider: "size",
                                    Title: _("Size"),
                                    Max: vgroup.FreeSize,
                                    Round: vgroup.ExtentSize
                                  }
                              ],
                              Action: {
                                  Title: _("Create"),
                                  action: function (vals) {
                                      if (vals.purpose == "block")
                                          return vgroup.CreatePlainVolume(vals.name, vals.size, { });
                                      else if (vals.purpose == "pool")
                                          return vgroup.CreateThinPoolVolume(vals.name, vals.size, { });
                                  }
                              }
                            });
            },
            vgroup_add_disk: function vgroup_add_disk(path) {
                var vgroup = client.vgroups[path];
                if (!vgroup)
                    return;

                dialog.open({ Title: _("Add Disks"),
                              Fields: [
                                  { SelectMany: "disks",
                                    Title: _("Disks"),
                                    Options: (utils.get_free_blockdevs(client).
                                              filter(function (b) {
                                                  if (client.blocks_part[b.path])
                                                      b = client.blocks[client.blocks_part[b.path].Table];
                                                  var lvol = (b &&
                                                              client.blocks_lvm2[b.path] &&
                                                              client.lvols[client.blocks_lvm2[b.path].LogicalVolume]);
                                                  return !lvol || lvol.VolumeGroup != path;
                                              }).
                                              map(function (b) {
                                                  return { value: b.path, Title: b.Name + " " + b.Description };
                                              })),
                                    validate: function (disks) {
                                        if (disks.length === 0)
                                            return _("At least one disk is needed.");
                                    }
                                  }
                              ],
                              Action: {
                                  Title: _("Add"),
                                  action: function (vals) {
                                      return cockpit.all(vals.disks.map(function (p) {
                                          return vgroup.AddDevice(p, {});
                                      }));
                                  }
                              }
                            });
            },
            pvol_empty_and_remove: function vgroup_add_disk(path) {
                var pvol = client.blocks_pvol[path];
                var vgroup = pvol && client.vgroups[pvol.VolumeGroup];
                if (!vgroup)
                    return;

                return (vgroup.EmptyDevice(path, {})
                        .then(function () {
                            vgroup.RemoveDevice(path, true, {});
                        }));
            },
            pvol_remove: function vgroup_add_disk(path) {
                var pvol = client.blocks_pvol[path];
                var vgroup = pvol && client.vgroups[pvol.VolumeGroup];
                if (!vgroup)
                    return;

                return vgroup.RemoveDevice(path, true, {});
            },

            format: function format(path) {
                if (client.blocks[path])
                    format_dialog(path);
                else if (client.lvols_block[path])
                    format_dialog(client.lvols_block[path].path);
            },
            delete: function delete_(path) {
                var block, block_part, lvol;

                /* This function can be called with either a inactive
                   LogicalVolume or a Block and in the latter case the
                   Block can either be a Partition or belong to a
                   active LogicalVolume.
                */

                block = client.blocks[path];
                if (block) {
                    block_part = client.blocks_part[path];
                    lvol = client.blocks_lvm2[path] && client.lvols[client.blocks_lvm2[path].LogicalVolume];
                } else {
                    lvol = client.lvols[path];
                }

                var name, danger;

                if (lvol) {
                    name = utils.lvol_name(lvol);
                    danger = _("Deleting a logical volume will delete all data in it.");
                } else if (block_part) {
                    name = utils.block_name(block);
                    danger = _("Deleting a partition will delete all data in it.");
                }

                if (name) {
                    dialog.open({ Title: cockpit.format(_("Please confirm deletion of $0"), name),
                                  Alerts: get_usage_alerts(path),
                                  Fields: [
                                  ],
                                  Action: {
                                      Danger: danger,
                                      Title: _("Delete"),
                                      action: function () {
                                          if (lvol)
                                              return lvol.Delete({ 'tear-down': { t: 'b', v: true }
                                                                 });
                                          else if (block_part)
                                              return block_part.Delete({ 'tear-down': { t: 'b', v: true }
                                                                       });
                                      }
                                  }
                                });
                }
            },

            job_cancel: function job_cancel(path) {
                var job = client.storaged_jobs[path] || client.udisks_jobs[path];
                if (job)
                    return job.Cancel({});
            }
        };

        $('#storage-detail').on('click', '[data-action]', function () {
            var action = $(this).attr('data-action');
            var args = [ ];
            if ($(this).attr('data-args'))
                args = JSON.parse($(this).attr('data-args'));
            else if ($(this).attr('data-arg'))
                args = [ $(this).attr('data-arg') ];
            var promise = actions[action].apply(this, args);
            if (promise)
                promise.fail(function (error) {
                    $('#error-popup-title').text(_("Error"));
                    $('#error-popup-message').text(error.toString());
                    $('#error-popup').modal('show');
                });
        });

        function create_simple_btn(title, action, args, excuse) {
            if (action)
                return mustache.render('<button class="btn btn-default storage-privileged" data-action="{{Action}}" data-args="{{Args}}">{{Title}}</button>',
                                       { Title: title, Action: action, Args: JSON.stringify(args) });
            else
                return mustache.render('<button class="btn btn-default tooltip-ct" disabled title="{{Excuse}}">{{Title}}</button>',
                                       { Title: title, Excuse: excuse });
        }

        var action_btn_tmpl = $("#action-btn-tmpl").html();
        mustache.parse(action_btn_tmpl);

        function create_block_action_btn (target, is_crypto_locked, is_partition) {
            function endsWith(str, suffix) {
                return str.indexOf(suffix, str.length - suffix.length) !== -1;
            }

            var block = endsWith(target.iface, ".Block")? target : null;
            var block_fsys = block && client.blocks_fsys[block.path];
            var block_lvm2 = block && client.blocks_lvm2[block.path];

            var lvol = endsWith(target.iface, ".LogicalVolume")? target : null;

            var is_filesystem         = (block && block.IdUsage == 'filesystem');
            var is_filesystem_mounted = (block_fsys && block_fsys.MountPoints.length > 0);
            var is_crypto             = (block && block.IdUsage == 'crypto');
            var is_lvol               = (lvol || (block_lvm2 && block_lvm2.LogicalVolume != "/"));
            var is_lvol_pool          = (lvol && lvol.Type == "pool");
            var is_lvol_active        = (block || (lvol && lvol.Active));
            var is_extended_part      = (block && client.blocks_part[block.path] &&
                                         client.blocks_part[block.path].IsContainer);
            var is_formattable        = (block && !block.ReadOnly && !is_extended_part);

            var lvol_arg;
            if (lvol)
                lvol_arg = lvol.path;
            else if (block_lvm2)
                lvol_arg = block_lvm2.LogicalVolume;

            var filesystem_action_spec =
                [ { title: _("Mount"),              action: "mount",   disabled: is_filesystem_mounted },
                  { title: _("Unmount"),            action: "unmount", disabled: !is_filesystem_mounted },
                ];

            // See format_dialog above for why we don't offer this for the old UDisks2
            var filesystem_action_spec_not_old_udisks2 =
                [ { title: _("Filesystem Options"), action: "fsys_options" }
                ];

            var crypto_action_spec =
                [ { title: _("Lock"),               action: "lock",    disabled: is_crypto_locked },
                  { title: _("Unlock"),             action: "unlock",  disabled: !is_crypto_locked }
                ];

            // See format_dialog above for why we don't offer this for the old UDisks2
            var crypto_action_spec_not_old_udisks2 =
                [ { title: _("Encryption Options"), action: "crypto_options" }
                ];

            var lvol_action_spec =
                [ { title: _("Resize"),             action: "resize",  arg: lvol_arg },
                  { title: _("Rename"),             action: "rename",  arg: lvol_arg }
                ];

            var lvol_block_action_spec =
                [ { title: _("Create Snapshot"),    action: "create_snapshot",
                    arg: lvol_arg
                  },
                  { title: _("Activate"),           action: "activate",   disabled: is_lvol_active,
                    arg: lvol_arg
                  },
                  { title: _("Deactivate"),         action: "deactivate", disabled: !is_lvol_active,
                    arg: lvol_arg
                  }
                ];

            var lvol_pool_action_spec =
                [ { title: _("Create Thin Volume"), action: "create_thin",
                    arg: lvol_arg
                  }
                ];

            var format_action_spec =
                [ { title: _("Format"),             action: "format" }
                ];

            var disable_delete = false;
            // The old UDisks2 can't properly delete unlocked luks devices
            if (client.is_old_udisks2 && is_crypto && !is_crypto_locked)
                disable_delete = true;

            var delete_action_spec =
                [ { title: _("Delete"),             action: "delete", disabled: disable_delete }
                ];

            var default_op = null;
            var action_spec = [ ];

            if (is_filesystem) {
                action_spec = action_spec.concat(filesystem_action_spec);
                if (!client.is_old_udisks2)
                    action_spec = action_spec.concat(filesystem_action_spec_not_old_udisks2);
                if (is_filesystem_mounted)
                    default_op = filesystem_action_spec[1]; // unmount
                else
                    default_op = filesystem_action_spec[0]; // mount
            } else if (is_crypto) {
                action_spec = action_spec.concat(crypto_action_spec);
                if (!client.is_old_udisks2)
                    action_spec = action_spec.concat(crypto_action_spec_not_old_udisks2);
                if (is_crypto_locked)
                    default_op = crypto_action_spec[1]; // unlock
                else
                    default_op = crypto_action_spec[0]; // lock
            }

            if (is_formattable) {
                action_spec = action_spec.concat(format_action_spec);
                if (!default_op)
                    default_op = format_action_spec[0]; // format
            }

            if (is_lvol) {
                action_spec = action_spec.concat(lvol_action_spec);
                if (is_lvol_pool) {
                    action_spec = action_spec.concat(lvol_pool_action_spec);
                    default_op = lvol_pool_action_spec[0]; // create-thin-volume
                } else {
                    action_spec = action_spec.concat(lvol_block_action_spec);
                    if (!default_op) {
                        if (is_lvol_active)
                            default_op = lvol_block_action_spec[2]; // deactivate
                        else
                            default_op = lvol_block_action_spec[1]; // activate
                    }
                }
            }

            if (is_partition || is_lvol) {
                action_spec = action_spec.concat(delete_action_spec);
                if (!default_op)
                    default_op = delete_action_spec[0]; // delete
            }

            return mustache.render(action_btn_tmpl,
                                   { arg: target.path,
                                     def: default_op,
                                     actions: action_spec
                                   });

        }

        function block_description(block, partition_label, cleartext_block)
        {
            var usage, line_1, line_2;
            var block_pvol = client.blocks_pvol[block.path];
            var block_lvm2 = client.blocks_lvm2[block.path];

            // XXX - redo with mustache?

            if (block.IdUsage == "filesystem") {
                usage = $('<span>').text(
                    cockpit.format(C_("storage-id-desc", "$0 File System"), block.IdType));
            } else if (block.IdUsage == "raid") {
                if (block.IdType == "linux_raid_member") {
                    usage = $('<span>').text(C_("storage-id-desc", "Linux MD-RAID Component"));
                } else if (block.IdType == "LVM2_member") {
                    usage = $('<span>').text(C_("storage-id-desc", "LVM2 Physical Volume"));
                } else {
                    usage = $('<span>').text(C_("storage-id-desc", "RAID Member"));
                }
                if (block_pvol && client.vgroups[block_pvol.VolumeGroup]) {
                    var vgroup = client.vgroups[block_pvol.VolumeGroup];
                    usage.append(
                        " of ",
                        $('<a>', { 'data-goto-vgroup': vgroup.Name }).
                            text(vgroup.Name));
                } else if (client.mdraids[block.MDRaidMember]) {
                    var mdraid = client.mdraids[block.MDRaidMember];
                    usage.append(
                        " of ",
                        $('<a>', { 'data-goto-mdraid': mdraid.UUID }).
                            text(utils.mdraid_name(mdraid)));
                }
            } else if (block.IdUsage == "crypto") {
                if (block.IdType == "crypto_LUKS") {
                    usage = $('<span>').text(C_("storage-id-desc", "LUKS Encrypted"));
                } else {
                    usage = $('<span>').text(C_("storage-id-desc", "Encrypted"));
                }
            } else if (block.IdUsage == "other") {
                if (block.IdType == "swap") {
                    usage = $('<span>').text(C_("storage-id-desc", "Swap Space"));
                } else {
                    usage = $('<span>').text(C_("storage-id-desc", "Other Data"));
                }
            } else {
                usage = $('<span>').text(C_("storage-id-desc", "Unrecognized Data"));
            }

            if (partition_label) {
                line_1 = $('<span>').append(
                    cockpit.format(_("$size $partition"), { size: utils.fmt_size(block.Size),
                                                            partition: partition_label }),
                    " (", usage, ")");
            } else  if (block_lvm2 && client.lvols[block_lvm2.LogicalVolume]) {
                var lvol = client.lvols[block_lvm2.LogicalVolume];
                line_1 = $('<span>').append(
                    cockpit.format(_("$size $partition"), { size: utils.fmt_size(block.Size),
                                                            partition: utils.lvol_name(lvol) }),
                    " (", usage, ")");
            } else
                line_1 = usage;

            line_2 = utils.block_name(block);
            if (block.IdUsage == "filesystem") {
                var block_fsys = client.blocks_fsys[block.path];
                line_2 += ", ";
                if (block_fsys && block_fsys.MountPoints.length > 0)
                    line_2 += cockpit.format(_("mounted on $0"), utils.decode_filename(block_fsys.MountPoints[0]));
                else
                    line_2 += _("not mounted");
            } else if (block.IdUsage == "crypto") {
                line_2 += ", ";
                if (cleartext_block)
                    line_2 += _("unlocked");
                else
                    line_2 += _("locked");
            }

            return $('<div>').append($('<div>').html(line_1), $('<div>').text(line_2)).html();
        }

        var content_tmpl = $("#content-tmpl").html();
        mustache.parse(content_tmpl);

        /* Content entry creation.
           XXX - make this more functional, without global state
        */

        var entries = [ ];

        function append_entry (level, name, desc, button, job_object) {
            entries.push({ Level: level,
                           Name: name,
                           Description: desc,
                           Button: button,
                           job_object: job_object
                         });
        }

        function append_non_partitioned_block (level, block, partition_label) {
            var id, name, desc, btn;
            var cleartext_block;

            if (block.IdUsage == 'crypto')
                cleartext_block = client.blocks_cleartext[block.path];

            btn = create_block_action_btn (block, !cleartext_block, !!partition_label);

            if (block.IdLabel.length > 0)
                name = block.IdLabel;
            else if (!btn)
                name = null;
            else
                name = "—";

            desc = block_description(block, partition_label, cleartext_block);

            append_entry (level, name, desc, btn, block.path);

            if (cleartext_block)
                append_device (level+1, cleartext_block);
        }

        function append_partitions (level, block) {
            var block_ptable = client.blocks_ptable[block.path];
            var device_level = level;

            var is_dos_partitioned = (block_ptable.Type == 'dos');
            var partitions = client.blocks_partitions[block.path];

            function append_free_space (level, start, size) {
                var desc;

                // There is a lot of rounding and aligning going on in
                // the storage stack.  All of udisks2, libblockdev,
                // and libparted seem to contribute their own ideas of
                // where a partition really should start.
                //
                // The start of partitions are aggressively rounded
                // up, sometimes twice, but the end is not aligned in
                // the same way.  This means that a few megabytes of
                // free space will show up between partitions.
                //
                // We hide these small free spaces because they are
                // unexpected and can't be used for anything anyway.
                //
                // "Small" is anything less than 3 MiB, which seems to
                // work okay.  (The worst case is probably creating
                // the first logical partition inside a extended
                // partition with udisks+libblockdev.  It leads to a 2
                // MiB gap.)

                var enable_dos_extended = false;
                if (size >= 3*1024*1024) {
                    if (is_dos_partitioned) {
                        if (level > device_level) {
                            desc = cockpit.format(_("$0 Free Space for Logical Partitions"),
                                                  utils.fmt_size(size));
                        } else {
                            desc = cockpit.format(_("$0 Free Space for Primary Partitions"),
                                                  utils.fmt_size(size));
                            enable_dos_extended = true;
                        }
                    } else {
                        desc = cockpit.format(_("$0 Free Space"), utils.fmt_size(size));
                    }

                    append_entry (level, null, desc,
                                  create_simple_btn (_("Create Partition"),
                                                     "create_partition", [ block.path, start, size,
                                                                           enable_dos_extended ]),
                                  null);
                }
            }

            function append_extended_partition (level, block, start, size) {
                var desc = cockpit.format(_("$0 Extended Partition"), utils.fmt_size(size));
                var btn = create_block_action_btn (block, false, true);
                append_entry (level, null, desc, btn, block.path);
                process_level (level + 1, start, size);
            }

            function process_level (level, container_start, container_size) {
                var n;
                var last_end = container_start;
                var total_end = container_start + container_size;
                var block, start, size, is_container, is_contained, partition_label;

                for (n = 0; n < partitions.length; n++) {
                    block = client.blocks[partitions[n].path];
                    start = partitions[n].Offset;
                    size = partitions[n].Size;
                    is_container = partitions[n].IsContainer;
                    is_contained = partitions[n].IsContained;

                    if (block === null)
                        continue;

                    if (level === device_level && is_contained)
                        continue;

                    if (level == device_level+1 && !is_contained)
                        continue;

                    if (start < container_start || start+size > container_start+container_size)
                        continue;

                    append_free_space(level, last_end, start - last_end);
                    if (is_container)
                        append_extended_partition(level, block, start, size);
                    else {
                        if (is_dos_partitioned) {
                            if (level > device_level)
                                partition_label = _("Logical Partition");
                            else
                                partition_label = _("Primary Partition");
                        } else
                            partition_label = _("Partition");
                        append_non_partitioned_block (level, block, partition_label);
                    }
                    last_end = start + size;
                }

                append_free_space(level, last_end, total_end - last_end);
            }

            process_level(device_level, 0, block.Size);
        }

        function append_device (level, block) {
            if (client.blocks_ptable[block.path])
                append_partitions(level, block);
            else
                append_non_partitioned_block(level, block, null);
        }

        function block_content_entries(block, level) {
            entries = [ ];
            append_device(level || 0, block);
            return entries;
        }

        var block_detail_tmpl = $("#block-detail-tmpl").html();
        mustache.parse(block_detail_tmpl);

        function render_block() {
            $('#storage-detail .breadcrumb .active').text(name);

            var block = client.slashdevs_block[name];
            if (!block)
                return;

            var block_model = {
                dbus: block,
                Name: utils.block_name(block),
                Size: utils.fmt_size_long(block.Size)
            };

            var drive = client.drives[block.Drive];
            var drive_ata = client.drives_ata[block.Drive];

            var assessment = null;
            if (drive_ata) {
                assessment = {
                    Failing: client.drives_ata.SmartFailing,
                    Temperature: drive_ata.SmartTemperature > 0 && utils.format_temperature(drive_ata.SmartTemperature)
                };
            }

            var drive_model = null;
            var content_block = block;
            if (drive) {
                var drive_block = client.drives_block[drive.path];
                var multipath_blocks = client.drives_multipath_blocks[drive.path];

                var multipath_model = null;
                if (multipath_blocks.length > 0) {
                    multipath_model = {
                        Devices: multipath_blocks.map(utils.block_name)
                    };
                }

                drive_model = {
                    dbus: drive,
                    Size: drive.Size > 0 && utils.fmt_size_long(drive.Size),
                    Assessment: assessment,
                    Device: drive_block && utils.block_name(drive_block),
                    Multipath: multipath_model,
                    MultipathActive: multipathd_service.state == "running"
                };

                content_block = drive_block;
            }

            return { header: mustache.render(block_detail_tmpl,
                                             { Block: block_model,
                                               Drive: drive_model
                                             }),
                     sidebar: null,
                     content: (content_block &&
                               mustache.render(content_tmpl,
                                               { Title: _("Content"),
                                                 path: content_block.path,
                                                 Entries: block_content_entries(content_block)
                                               }))
                   };
        }

        var mdraid_detail_tmpl = $("#mdraid-detail-tmpl").html();
        mustache.parse(mdraid_detail_tmpl);

        var mdraid_members_tmpl = $("#mdraid-members-tmpl").html();
        mustache.parse(mdraid_members_tmpl);

        function render_mdraid() {
            var mdraid = client.uuids_mdraid[name];
            if (!mdraid)
                return;

            var block = client.mdraids_block[mdraid.path];

            function format_level(str) {
                return { "raid0": _("RAID 0"),
                         "raid1": _("RAID 1"),
                         "raid4": _("RAID 4"),
                         "raid5": _("RAID 5"),
                         "raid6": _("RAID 6"),
                         "raid10": _("RAID 10")
                       }[str] || cockpit.format(_("RAID ($0)"), str);
            }

            var level = format_level(mdraid.Level);
            if (mdraid.NumDevices > 0)
                level += ", " + cockpit.format(_("$0 Disks"), mdraid.NumDevices);
            if (mdraid.ChunkSize > 0)
                level += ", " + cockpit.format(_("$0 Chunk Size"), utils.fmt_size(mdraid.ChunkSize));

            var bitmap = null;
            if (mdraid.BitmapLocation)
                bitmap = {
                    Value: utils.decode_filename(mdraid.BitmapLocation) != "none"
                };

            var degraded_message = null;
            if (mdraid.Degraded > 0) {
                degraded_message = cockpit.format(
                                       cockpit.ngettext("$0 disk is missing", "$0 disks are missing", mdraid.Degraded),
                                       mdraid.Degraded
                                   );
            }

            /* Older versions of Udisks/storaged don't have a Running property */
            var running = mdraid.Running;
            if (running === undefined)
                running = mdraid.ActiveDevices && mdraid.ActiveDevices.length > 0;

            var mdraid_model = {
                dbus: mdraid,
                Name: utils.mdraid_name(mdraid),
                Size: utils.fmt_size_long(mdraid.Size),
                Level: level,
                Bitmap: bitmap,
                Degraded: degraded_message,
                State: running ? _("Running") : _("Not running"),
            };

            var block_model = null;
            if (block) {
                block_model = {
                    dbus: block,
                    Device: utils.decode_filename(block.PreferredDevice)
                };
            }

            function make_member(block) {
                var active_state = utils.array_find(mdraid.ActiveDevices, function (as) {
                    return as[0] == block.path;
                });

                function make_state(state) {
                    return {
                        Description: { faulty:       _("FAILED"),
                                       in_sync:      _("In Sync"),
                                       spare:        active_state[1] < 0 ? _("Spare") : _("Recovering"),
                                       write_mostly: _("Write-mostly"),
                                       blocked:      _("Blocked")
                                     }[state] || cockpit.format(_("Unknown ($0)"), state),
                        Danger: state == "faulty"
                    };
                }

                return {
                    path: block.path,
                    LinkTarget: utils.get_block_link_target(client, block.path),
                    Description: utils.decode_filename(block.PreferredDevice),
                    Slot: active_state && active_state[1] >= 0 && active_state[1].toString(),
                    States: active_state && active_state[2].map(make_state)
                };
            }

            var actions = [
                { title: _("Start"),           action: 'mdraid_start' },
                { title: _("Stop"),            action: 'mdraid_stop' },
                { title: _("Start Scrubbing"), action: 'mdraid_start_scrub' },
                { title: _("Stop Scrubbing"),  action: 'mdraid_stop_scrub' },
                { title: _("Delete"),          action: 'mdraid_delete' }
            ];

            var def_action;
            if (running)
                def_action = actions[1];  // Stop
            else
                def_action = actions[0];  // Start

            return { header: mustache.render(mdraid_detail_tmpl,
                                             { MDRaid: mdraid_model,
                                               MDRaidButton: mustache.render(action_btn_tmpl,
                                                                             { arg: mdraid.path,
                                                                               def: def_action,
                                                                               actions: actions
                                                                             }),
                                               Block: block_model
                                             }),
                     sidebar: mustache.render(mdraid_members_tmpl,
                                              { MDRaid: mdraid_model,
                                                Members: client.mdraids_members[mdraid.path].map(make_member),
                                                DynamicMembers: (mdraid.Level != "raid0")
                                              }),
                     content: (block &&
                               mustache.render(content_tmpl,
                                               { Title: _("Content"),
                                                 path: block.path,
                                                 Entries: block_content_entries(block)
                                               }))
                   };
        }

        function volume_group_content_entries(vgroup, level) {

            function append_logical_volume_block (level, block, lvol) {
                var btn, desc;
                if (client.blocks_ptable[block.path]) {
                    desc = cockpit.format(_("$size $desc"),
                             { desc: lvol.Name,
                               size: utils.fmt_size(block.Size) });
                    desc += "<br/>" + $('<span>').text(utils.decode_filename(block.PreferredDevice));
                    btn = create_block_action_btn (block, false, false);
                    append_entry (level, null, desc, btn, block.path);
                    append_partitions (level+1, block);
                } else
                    append_non_partitioned_block (level, block, null);
            }

            function append_logical_volume (level, lvol) {
                var btn, desc, ratio, block;

                if (lvol.Type == "pool") {
                    ratio = Math.max(lvol.DataAllocatedRatio, lvol.MetadataAllocatedRatio);
                    desc = cockpit.format(_("$size $desc<br/>${percent}% full"),
                                          { size: utils.fmt_size(lvol.Size),
                                            desc: utils.lvol_name(lvol),
                                            percent: (ratio*100).toFixed(0)
                                          });
                    btn = create_block_action_btn (lvol, false, false);
                    append_entry (level, null, desc, btn);
                    client.lvols_pool_members[lvol.path].forEach(function (member_lvol) {
                        append_logical_volume (level+1, member_lvol);
                    });
                } else {
                    block = client.lvols_block[lvol.path];
                    if (block)
                        append_logical_volume_block (level, block, lvol);
                    else {
                        // If we can't find the block for a active
                        // volume, Storaged or something below is
                        // probably misbehaving, and we show it as
                        // "unsupported".

                        desc = cockpit.format(_("$size $desc<br/>($state)"),
                                              { size: utils.fmt_size(lvol.Size),
                                                desc: utils.lvol_name(lvol),
                                                state: lvol.Active? _("active, but unsupported") : _("inactive")
                                              });
                        btn = create_block_action_btn (lvol, false, false);
                        append_entry (level, null, desc, btn, null);
                    }
                }
            }

            entries = [ ];
            level = level || 0;

            client.vgroups_lvols[vgroup.path].forEach(function (lvol) {
                if (lvol.ThinPool == "/")
                    append_logical_volume(level, lvol);
            });

            if (vgroup.FreeSize > 0) {
                var btn, desc;

                desc = cockpit.format(_("$0 Free Space for Logical Volumes"), utils.fmt_size(vgroup.FreeSize));
                btn = create_simple_btn (_("Create Logical Volume"), "vgroup_create_lvol", [ vgroup.path ]);
                append_entry (level, null, desc, btn, null);
            }

            return entries;
        }

        var vgroup_detail_tmpl = $("#vgroup-detail-tmpl").html();
        mustache.parse(vgroup_detail_tmpl);

        var vgroup_pvs_tmpl = $("#vgroup-pvs-tmpl").html();
        mustache.parse(vgroup_pvs_tmpl);

        var poll_timer;

        function render_vgroup() {
            var vgroup = client.vgnames_vgroup[name];
            if (!vgroup)
                return;

            var pvols = client.vgroups_pvols[vgroup.path];

            if (vgroup.NeedsPolling && poll_timer === null) {
                poll_timer = window.setInterval(function () { vgroup.Poll(); }, 2000);
            } else if (!vgroup.NeedsPolling && poll_timer !== null) {
                window.clearInterval(poll_timer);
                poll_timer =  null;
            }

            var vgroup_model = {
                dbus: vgroup,
                Size: utils.fmt_size_long(vgroup.Size)
            };

            function make_pvol(pvol) {
                var block = client.blocks[pvol.path];
                var action = null;
                var excuse = null;
                if (pvols.length == 1) {
                    excuse = _("The last physical volume of a volume group cannot be removed.");
                } else if (pvol.FreeSize < pvol.Size) {
                    if (pvol.Size <= vgroup.FreeSize)
                        action = "pvol_empty_and_remove";
                    else
                        excuse = cockpit.format(_("There is not enough free space elsewhere to remove this physical volume.  At least $0 more free space is needed."),
                                                utils.fmt_size(pvol.Size - vgroup.FreeSize));
                } else {
                    action = "pvol_remove";
                }
                return {
                    dbus: block,
                    LinkTarget: utils.get_block_link_target(client, pvol.path),
                    Device: utils.decode_filename(block.PreferredDevice),
                    Sizes: cockpit.format(_("$0, $1 free"),
                                          utils.fmt_size(pvol.Size),
                                          utils.fmt_size(pvol.FreeSize)),
                    action: action,
                    args: JSON.stringify([ pvol.path ]),
                    Excuse: excuse
                };
            }

            var actions = [
                { action: "vgroup_rename", title: _("Rename") },
                { action: "vgroup_delete", title: _("Delete") }
            ];

            return { header: mustache.render(vgroup_detail_tmpl,
                                             { VGroup: vgroup_model,
                                               VGroupButton: mustache.render(action_btn_tmpl,
                                                                             { arg: vgroup.path,
                                                                               def: actions[0], // Rename
                                                                               actions: actions
                                                                             }),
                                             }),
                     sidebar: mustache.render(vgroup_pvs_tmpl,
                                              { VGroup: vgroup_model,
                                                PVols: pvols.map(make_pvol)
                                              }),
                     content: mustache.render(content_tmpl,
                                              { Title: _("Logical Volumes"),
                                                Entries: volume_group_content_entries(vgroup)
                                              })
                   };
        }

        function render() {
            $('#storage-detail .breadcrumb .active').text(name);

            var html;
            if (type == 'block')
                html = render_block();
            else if (type == 'mdraid')
                html = render_mdraid();
            else if (type == 'vgroup')
                html = render_vgroup();

            if (html) {
                $('button.tooltip-ct').tooltip('destroy');
                $('#detail-header').amend(html.header);
                $('#detail-sidebar').amend(html.sidebar);
                $('#detail-content').amend(html.content);
                $('button.tooltip-ct').tooltip();

                if (html.sidebar)
                    $('#detail-body').attr("class", "col-md-8 col-lg-9 col-md-pull-4 col-lg-pull-3");
                else
                    $('#detail-body').attr("class", "col-md-12");

            } else {
                $('#detail-header').text(_("Not found"));
                $('#detail-sidebar').empty();
                $('#detail-content').empty();
            }

            jobs.update('#storage-detail');
            $('#detail-jobs').amend(jobs.render());
            permissions.update();
        }

        $(multipathd_service).on('changed', render);
        $(client).on('changed', render);

        $('#storage-detail-log').append(
            journal.logbox([ "_SYSTEMD_UNIT=storaged.service", "+",
                            "_SYSTEMD_UNIT=udisks2.service", "+",
                            "_SYSTEMD_UNIT=dm-event.service", "+",
                            "_SYSTEMD_UNIT=smartd.service", "+",
                            "_SYSTEMD_UNIT=multipathd.service"
                          ],
                          10));

        $('#storage-detail .breadcrumb a').on("click", function() {
            cockpit.location.go('/');
        });

        function hide() {
            name = null;
            $('#storage-detail').hide();
        }

        function show(t, n) {
            if (poll_timer !== null) {
                window.clearInterval(poll_timer);
                poll_timer =  null;
            }

            type = t;
            name = n;
            render();
            $('#storage-detail').show();
        }

        return {
            show: show,
            hide: hide
        };
    }

    module.exports = {
        init: init_details
    };

}());
