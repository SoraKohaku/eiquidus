const Stats = require('../models/stats');
const Tx = require('../models/tx');
const Address = require('../models/address');
const AddressTx = require('../models/addresstx');
const lib = require('./explorer');
const settings = require('../lib/settings');
const async = require('async');
let stopSync = false;

function check_delete_tx(tx, block_height, tx_count, timeout, cb) {
  // check if the tx object exists and does not match the current block height
  if (tx && tx.blockindex != block_height) {
    // the transaction exists but does not match the correct block height, therefore it should be deleted
    module.exports.delete_and_cleanup_tx(tx.txid, tx.blockindex, tx_count, timeout, function(updated_tx_count) {
      // finished removing the transaction
      return cb(updated_tx_count, true);
    });
  } else {
    // tx dosn't exist or block heights match so nothing to do
    return cb(tx_count, false);
  }
}

function delete_tx(txid, block_height, cb) {
  // delete the tx from the local database
  Tx.deleteOne({txid: txid, blockindex: block_height}).then((tx_result) => {
    return cb(null, tx_result);
  }).catch((err) => {
    return cb(err, null);
  });
}

function fix_address_data(address_data, cb) {
  var addr_inc = {};
  var amount = address_data.amount;

  // determine how to fix the address balances
  if (address_data.a_id == 'coinbase')
    addr_inc.sent = -amount;
  else if (amount < 0) {
    // vin
    addr_inc.sent = amount;
    addr_inc.balance = -amount;
  } else {
    // vout
    addr_inc.received = -amount;
    addr_inc.balance = -amount;
  }

  // reverse the amount from the running totals in the Address collection for the current address
  Address.findOneAndUpdate({a_id: address_data.a_id}, {
    $inc: addr_inc
  }, {
    upsert: false
  }).then((return_address) => {
    // finished fixing the address balance data 
    return cb();
  }).catch((err) => {
    console.log(err);
    return cb();
  });
}

function hex_to_ascii(hex) {
  let str = '';

  for (var i = 0; i < hex.length; i += 2)
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));

  return str;
}

function update_address(hash, blockheight, txid, amount, type, cb) {
  let addr_inc = {}

  if (hash == 'coinbase')
    addr_inc.sent = amount;
  else {
    if (type == 'vin') {
      addr_inc.sent = amount;
      addr_inc.balance = -amount;
    } else {
      addr_inc.received = amount;
      addr_inc.balance = amount;
    }
  }

  Address.findOneAndUpdate({a_id: hash}, {
    $inc: addr_inc
  }, {
    new: true,
    upsert: true
  }).then((address) => {
    if (hash != 'coinbase') {
      AddressTx.findOneAndUpdate({a_id: hash, txid: txid}, {
        $inc: {
          amount: addr_inc.balance
        },
        $set: {
          a_id: hash,
          blockindex: blockheight,
          txid: txid
        }
      }, {
        new: true,
        upsert: true
      }).then((addresstx) => {
        return cb();
      }).catch((err) => {
        return cb(err);
      });
    } else
      return cb();
  }).catch((err) => {
    return cb(err);
  });
}

module.exports = {
  save_tx: function(txid, blockheight, block, cb) {
    lib.get_rawtransaction(txid, function(tx) {
      if (tx && tx != `${settings.localization.ex_error}: ${settings.localization.check_console}`) {
        lib.prepare_vin(tx, function(vin, tx_type_vin) {
          lib.prepare_vout(tx.vout, txid, vin, ((!settings.blockchain_specific.zksnarks.enabled || typeof tx.vjoinsplit === 'undefined' || tx.vjoinsplit == null) ? [] : tx.vjoinsplit), function(vout, nvin, tx_type_vout) {
            lib.syncLoop(nvin.length, function (loop) {
              const i = loop.iteration();

              // check if address is inside an array
              if (Array.isArray(nvin[i].addresses)) {
                // extract the address
                nvin[i].addresses = nvin[i].addresses[0];
              }

              update_address(nvin[i].addresses, blockheight, txid, nvin[i].amount, 'vin', function() {
                loop.next();
              });
            }, function() {
              lib.syncLoop(vout.length, function (subloop) {
                const t = subloop.iteration();

                // check if address is inside an array
                if (Array.isArray(vout[t].addresses)) {
                  // extract the address
                  vout[t].addresses = vout[t].addresses[0];
                }

                if (vout[t].addresses) {
                  update_address(vout[t].addresses, blockheight, txid, vout[t].amount, 'vout', function() {
                    subloop.next();
                  });
                } else
                  subloop.next();
              }, function() {
                lib.calculate_total(vout, function(total) {
                  var op_return = null;
                  var algo = null;

                  // check if the op_return value should be decoded and saved
                  if (settings.transaction_page.show_op_return) {
                    // loop through vout to find the op_return value
                    tx.vout.forEach(function (vout_data) {
                      // check if the op_return value exists
                      if (vout_data.scriptPubKey != null && vout_data.scriptPubKey.asm != null && vout_data.scriptPubKey.asm.indexOf('OP_RETURN') > -1) {
                        // decode the op_return value
                        op_return = hex_to_ascii(vout_data.scriptPubKey.asm.replace('OP_RETURN', '').trim());
                      }
                    });
                  }

                  // check if the algo value should be saved
                  if (settings.block_page.multi_algorithm.show_algo) {
                    // get the algo value
                    algo = block[settings.block_page.multi_algorithm.key_name];
                  }

                  const newTx = new Tx({
                    txid: tx.txid,
                    vin: (vin == null || vin.length == 0 ? [] : nvin),
                    vout: vout,
                    total: total.toFixed(8),
                    timestamp: tx.time,
                    blockhash: tx.blockhash,
                    blockindex: blockheight,
                    tx_type: (tx_type_vout == null ? tx_type_vin : tx_type_vout),
                    op_return: op_return,
                    algo: algo
                  });

                  newTx.save().then(() => {
                    return cb(null, vout.length > 0);
                  }).catch((err) => {
                    return cb(err, false);
                  });
                });
              });
            });
          });
        });
      } else
        return cb('tx not found: ' + txid, false);
    });
  },

  // updates tx & address balances
  update_tx_db: function(coin, start, end, txes, timeout, check_only, cb) {
    let blocks_to_scan = [];
    let parallel_tasks = settings.sync.block_parallel_tasks;
    let last_block_height_to_save = 0;

    // fix for invalid block height (skip genesis block as it should not have valid txs)
    if (typeof start === 'undefined' || start < 1)
      start = 1;

    if (parallel_tasks < 1)
      parallel_tasks = 1;

    for (i = start; i < (end + 1); i++)
      blocks_to_scan.push(i);

    // create an array to help keep track of all block numbers being processed at the same time
    const block_numbers = Array(parallel_tasks).fill(0);

    // add a queue to manage access to the block array
    const block_queue = async.queue((task, cb) => {
      const { block_height, onComplete } = task;

      // select the first block number array index that is set to 0
      const slotIndex = block_numbers.findIndex((v) => v === 0);

      // wait for an available slot in the block array
      if (slotIndex === -1) {
        setTimeout(() => block_queue.push(task, cb), 1); // retry after 1 ms
        return;
      }

      // assign the current block height to the slot
      block_numbers[slotIndex] = block_height;

      // pass the slot index back
      onComplete(slotIndex);
      cb();
    });

    async.eachLimit(blocks_to_scan, parallel_tasks, function(block_height, next_block) {
      // add the current block height to a queue and wait for it to be next in queue before starting to sync the block
      block_queue.push(
        {
          block_height,
          onComplete: (slotIndex) => {
            // check if it's time to save the last known block height to the database
            if (
                (
                  check_only == 0 &&
                  block_height % settings.sync.save_stats_after_sync_blocks === 0
                ) ||
                (
                  last_block_height_to_save > 0 &&
                  block_numbers.every((value) => value >= last_block_height_to_save)
                )
            ) {
              // get the lowest block height currently being processed
              const lowest_block_height = Math.min(...block_numbers.filter((v) => v !== 0));

              // check if the current thread is processing the lowest block height
              // or there was a previous block height that needs to be saved now that all threads have advanced beyond that saved height
              if (block_height == lowest_block_height || last_block_height_to_save > 0) {
                // save the last known block height to the database along with the current tx count
                Stats.updateOne({coin: coin}, {
                  last: (last_block_height_to_save == 0 ? block_height : last_block_height_to_save),
                  txes: txes
                }).then(() => {});

                // reset the "last block height to save" back to 0
                last_block_height_to_save = 0;
              } else if (last_block_height_to_save == 0) {
                // update the last known block height that should be saved
                last_block_height_to_save = block_height;
              }
            } else if (check_only == 1)
              console.log('Checking block ' + block_height + '...');

            lib.get_blockhash(block_height, function(blockhash) {
              if (blockhash) {
                lib.get_block(blockhash, function(block) {
                  if (block) {
                    async.eachLimit(block.tx, parallel_tasks, function(txid, next_tx) {
                      Tx.findOne({txid: txid}).then((tx) => {
                        if (tx && check_only != 2) {
                          setTimeout(function() {
                            tx = null;

                            // check if the script is stopping
                            if (stopSync && check_only != 2) {
                              // stop the loop
                              next_tx({});
                            } else
                              next_tx();
                          }, timeout);
                        } else {
                          // check if the transaction exists but doesn't match the current block height
                          check_delete_tx(tx, block_height, txes, timeout, function(updated_txes, tx_deleted) {
                            // update the running tx count
                            txes = updated_txes;

                            // check if this tx should be added to the local database
                            if (tx_deleted || !tx) {
                              // save the transaction to local database
                              module.exports.save_tx(txid, block_height, block, function(err, tx_has_vout) {
                                if (err) {
                                  // output a nicer error msg for the 11000 error code "duplicate key error collection" which can happen in some blockchains with non-standard txids being reused
                                  if (err.code === 11000)
                                    console.log(`${settings.localization.ex_warning}: ${block_height}: ${txid} already exists`);
                                  else
                                    console.log(err);
                                }
                                else
                                  console.log('%s: %s', block_height, txid);

                                if (tx_has_vout)
                                  txes++;

                                setTimeout(function() {
                                  tx = null;

                                  // check if the script is stopping
                                  if (stopSync && check_only != 2) {
                                    // stop the loop
                                    next_tx({});
                                  } else
                                    next_tx();
                                }, timeout);
                              });
                            } else {
                              // skip adding the current tx
                              setTimeout(function() {
                                tx = null;

                                // check if the script is stopping
                                if (stopSync && check_only != 2) {
                                  // stop the loop
                                  next_tx({});
                                } else
                                  next_tx();
                              }, timeout);
                            }
                          });
                        }
                      }).catch((err) => {
                        console.log(err);

                        setTimeout(function() {
                          tx = null;

                          // check if the script is stopping
                          if (stopSync && check_only != 2) {
                            // stop the loop
                            next_tx({});
                          } else
                            next_tx();
                        }, timeout);
                      });
                    }, function() {
                      setTimeout(function() {
                        blockhash = null;
                        block = null;

                        // reset the slot in the block array back to 0
                        block_numbers[slotIndex] = 0;

                        // check if the script is stopping
                        if (stopSync && check_only != 2) {
                          // stop the loop
                          next_block({});
                        } else
                          next_block();
                      }, timeout);
                    });
                  } else {
                    console.log('Block not found: %s', blockhash);

                    setTimeout(function() {
                      // reset the slot in the block array back to 0
                      block_numbers[slotIndex] = 0;

                      // check if the script is stopping
                      if (stopSync && check_only != 2) {
                        // stop the loop
                        next_block({});
                      } else
                        next_block();
                    }, timeout);
                  }
                });
              } else {
                setTimeout(function() {
                  // reset the slot in the block array back to 0
                  block_numbers[slotIndex] = 0;

                  // check if the script is stopping
                  if (stopSync && check_only != 2) {
                    // stop the loop
                    next_block({});
                  } else
                    next_block();
                }, timeout);
              }
            });
          },
        },
        () => {}
      );
    }, function() {
      var statUpdateObject = {};

      // check what stats data should be updated
      if (stopSync || check_only == 2) {
        // only update txes when fixing invalid and missing blocks or when a "normal" sync was stopped prematurely
        statUpdateObject.txes = txes;
      } else {
        // update last and txes values for "normal" sync that finishes without being stopped prematurely
        statUpdateObject = {
          txes: txes,
          last: end
        };
      }

      // update local stats
      Stats.updateOne({coin: coin}, statUpdateObject).then(() => {
        return cb(txes);
      }).catch((err) => {
        console.log(err);
        return cb(txes);
      });
    });
  },

  delete_and_cleanup_tx: function(txid, block_height, tx_count, timeout, cb) {
    // lookup all address tx records associated with the current tx
    AddressTx.find({txid: txid}).exec().then((address_txes) => {
      if (address_txes.length == 0) {
        // no vouts for this tx, so just delete the tx without cleaning up addresses
        delete_tx(txid, block_height, function(tx_err, tx_result) {
          if (tx_err) {
            console.log(tx_err);
            return cb(tx_count);
          } else {
            // NOTE: do not subtract from the tx_count here because only txes with vouts are counted
            return cb(tx_count);
          }
        });
      } else {
        // lookup the current tx in the local database
        Tx.findOne({txid: txid}).then((tx) => {
          var addressTxArray = [];
          var has_vouts = (tx.vout != null && tx.vout.length > 0);

          // check if this is a coinbase tx
          if (tx.vin == null || tx.vin.length == 0) {
            // add a coinbase tx into the addressTxArray array
            addressTxArray.push({
              txid: txid,
              a_id: 'coinbase',
              amount: tx.total
            });
          }

          // check if there are any vin addresses
          if (tx.vin != null && tx.vin.length > 0) {
            // loop through the vin data
            for (var vin_tx_counter = tx.vin.length - 1; vin_tx_counter >= 0; vin_tx_counter--) {
              // loop through the addresstxe data
              for (var vin_addresstx_counter = address_txes.length - 1; vin_addresstx_counter >= 0; vin_addresstx_counter--) {
                // check if there is a tx record that exactly matches to the addresstx
                if (tx.vin[vin_tx_counter].addresses == address_txes[vin_addresstx_counter].a_id && tx.vin[vin_tx_counter].amount == -address_txes[vin_addresstx_counter].amount) {
                  // add the address into the addressTxArray array
                  addressTxArray.push({
                    txid: txid,
                    a_id: tx.vin[vin_tx_counter].addresses,
                    amount: address_txes[vin_addresstx_counter].amount
                  });

                  // remove the found records from both arrays
                  tx.vin.splice(vin_tx_counter, 1);
                  address_txes.splice(vin_addresstx_counter, 1);

                  break;
                }
              }
            }
          }

          // check if there are any vout addresses
          if (tx.vout != null && tx.vout.length > 0) {
            // loop through the vout data
            for (var vout_tx_counter = tx.vout.length - 1; vout_tx_counter >= 0; vout_tx_counter--) {
              // loop through the addresstxe data
              for (var vout_addresstx_counter = address_txes.length - 1; vout_addresstx_counter >= 0; vout_addresstx_counter--) {
                // check if there is a tx record that exactly matches to the addresstx
                if (tx.vout[vout_tx_counter].addresses == address_txes[vout_addresstx_counter].a_id && tx.vout[vout_tx_counter].amount == address_txes[vout_addresstx_counter].amount) {
                  // add the address into the addressTxArray array
                  addressTxArray.push({
                    txid: txid,
                    a_id: tx.vout[vout_tx_counter].addresses,
                    amount: address_txes[vout_addresstx_counter].amount
                  });

                  // remove the found records from both arrays
                  tx.vout.splice(vout_tx_counter, 1);
                  address_txes.splice(vout_addresstx_counter, 1);

                  break;
                }
              }
            }
          }

          // check if there are still more vin/vout records to process
          if (tx.vin.length > 0 || tx.vout.length > 0 || address_txes.length > 0) {
            // get all unique remaining addresses
            var address_list = [];

            // get unique addresses from the tx vin
            tx.vin.forEach(function(vin) {
              if (address_list.indexOf(vin.addresses) == -1)
                address_list.push(vin.addresses);
            });

            // get unique addresses from the tx vout
            tx.vout.forEach(function(vout) {
              if (address_list.indexOf(vout.addresses) == -1)
                address_list.push(vout.addresses);
            });

            // get unique addresses from the addresstxes
            address_txes.forEach(function(address_tx) {
              if (address_list.indexOf(address_tx.a_id) == -1)
                address_list.push(address_tx.a_id);
            });

            // loop through each unique address
            address_list.forEach(function(address) {
              var vin_total = 0;
              var vout_total = 0;
              var address_tx_total = 0;

              // add up all the vin amounts for this address
              tx.vin.forEach(function(vin) {
                // check if this is the correct address
                if (vin.addresses == address)
                  vin_total += vin.amount;
              });

              // add up all the vout amounts for this address
              tx.vout.forEach(function(vout) {
                // check if this is the correct address
                if (vout.addresses == address)
                  vout_total += vout.amount;
              });

              // add up all the addresstx amounts for this address
              address_txes.forEach(function(address_tx) {
                // check if this is the correct address
                if (address_tx.a_id == address)
                  address_tx_total += address_tx.amount;
              });

              // check if the tx and addresstx totals match
              if ((vout_total - vin_total) == address_tx_total) {
                // the values match (this indicates that this address sent coins to themselves)
                // add a vin record for this address into the addressTxArray array
                addressTxArray.push({
                  txid: txid,
                  a_id: address,
                  amount: -vin_total
                });

                // add a vout record for this address into the addressTxArray array
                addressTxArray.push({
                  txid: txid,
                  a_id: address,
                  amount: vout_total
                });
              } else {
                // the values do not match (this indicates there was a problem saving the data)
                // output the data for this address as-is, using the addresstx values
                address_txes.forEach(function(address_tx) {
                  // check if this is the correct address
                  if (address_tx.a_id == address) {
                    // add a record for this address into the addressTxArray array
                    addressTxArray.push({
                      txid: txid,
                      a_id: address,
                      amount: address_tx.amount
                    });
                  }
                });
              }
            });
          }

          // loop through the address txes
          lib.syncLoop(addressTxArray.length, function(address_loop) {
            var a = address_loop.iteration();

             // fix the balance, sent and received data for the current address
            fix_address_data(addressTxArray[a], function() {
              setTimeout(function() {
                // move to the next address record
                address_loop.next();
              }, timeout);
            });
          }, function() {
            // delete all AddressTx records from the local collection for this tx
            AddressTx.deleteMany({txid: txid}).then((address_tx_result) => {
              // delete the tx from the local database
              delete_tx(txid, block_height, function(tx_err, tx_result) {
                if (tx_err) {
                  console.log(tx_err);
                  return cb(tx_count);
                } else {
                  // check if the deleted tx had vouts
                  if (has_vouts) {
                    // keep a running total of txes that were removed
                    tx_count -= tx_result.deletedCount;
                  }

                  return cb(tx_count);
                }
              });
            }).catch((err) => {
              console.log(err);

              // delete the tx from the local database
              delete_tx(txid, block_height, function(tx_err, tx_result) {
                if (tx_err) {
                  console.log(tx_err);
                  return cb(tx_count);
                } else {
                  // check if the deleted tx had vouts
                  if (has_vouts) {
                    // keep a running total of txes that were removed
                    tx_count -= tx_result.deletedCount;
                  }

                  return cb(tx_count);
                }
              });
            });
          });
        }).catch((err) => {
          console.log(err);
          return cb(tx_count);
        });
      }
    }).catch((err) => {
      console.log(err);
      return cb(tx_count);
    });
  },

  setStopSync: function(value) {
    stopSync = value;
  },

  getStopSync: function() {
    return stopSync;
  }
};