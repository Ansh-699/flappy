/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/flappy_bird.json`.
 */
export type FlappyBird = {
  "address": "DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj",
  "metadata": {
    "name": "flappyBird",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Fully on-chain Flappy Bird game using MagicBlock Ephemeral Rollups"
  },
  "instructions": [
    {
      "name": "commit",
      "docs": [
        "Commit game state to the base layer"
      ],
      "discriminator": [
        223,
        140,
        142,
        165,
        229,
        208,
        156,
        74
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "delegate",
      "docs": [
        "Delegate the game account to the Ephemeral Rollup"
      ],
      "discriminator": [
        90,
        147,
        75,
        178,
        85,
        88,
        4,
        137
      ],
      "accounts": [
        {
          "name": "payer",
          "signer": true
        },
        {
          "name": "bufferPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "pda"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                188,
                28,
                140,
                9,
                85,
                28,
                55,
                101,
                50,
                136,
                245,
                110,
                202,
                93,
                206,
                13,
                22,
                186,
                138,
                199,
                111,
                119,
                35,
                55,
                182,
                236,
                55,
                134,
                76,
                21,
                214,
                152
              ]
            }
          }
        },
        {
          "name": "delegationRecordPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "pda"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "pda"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "pda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "ownerProgram",
          "address": "DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "endGame",
      "docs": [
        "End the game - called when collision detected or manually",
        "Note: On ER, any signer can play (session/burner wallet support)"
      ],
      "discriminator": [
        224,
        135,
        245,
        99,
        67,
        175,
        121,
        252
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "game.authority",
                "account": "gameState"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be the game's authority - verified in each instruction"
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "flap",
      "docs": [
        "Player flaps (jumps) - this is the main input during gameplay",
        "Note: On ER, any signer can play (session/burner wallet support)"
      ],
      "discriminator": [
        245,
        201,
        73,
        56,
        237,
        67,
        155,
        134
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "game.authority",
                "account": "gameState"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be the game's authority - verified in each instruction"
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "Initialize a new game account",
        "Uses PDA derivation with player's public key"
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer"
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "resetGame",
      "docs": [
        "Reset game to initial state",
        "Note: On ER, any signer can play (session/burner wallet support)"
      ],
      "discriminator": [
        97,
        146,
        71,
        156,
        110,
        206,
        124,
        224
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "game.authority",
                "account": "gameState"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be the game's authority - verified in each instruction"
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "startGame",
      "docs": [
        "Start a new game - resets bird position and score",
        "Note: On ER, any signer can play (session/burner wallet support)",
        "Security is provided by the ER's account delegation model"
      ],
      "discriminator": [
        249,
        47,
        252,
        172,
        184,
        162,
        245,
        14
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "game.authority",
                "account": "gameState"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be the game's authority - verified in each instruction"
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "tick",
      "docs": [
        "Update game state - called each frame to advance physics",
        "This is the main game loop tick",
        "Note: On ER, any signer can play (session/burner wallet support)"
      ],
      "discriminator": [
        92,
        79,
        44,
        8,
        101,
        80,
        63,
        15
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "game.authority",
                "account": "gameState"
              }
            ]
          }
        },
        {
          "name": "signer",
          "docs": [
            "Must be the game's authority - verified in each instruction"
          ],
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "undelegate",
      "docs": [
        "Undelegate and commit final state"
      ],
      "discriminator": [
        131,
        148,
        180,
        198,
        91,
        104,
        42,
        238
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101,
                  95,
                  118,
                  50
                ]
              },
              {
                "kind": "account",
                "path": "payer"
              }
            ]
          }
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "gameState",
      "discriminator": [
        144,
        94,
        208,
        172,
        248,
        99,
        134,
        120
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "gameNotPlaying",
      "msg": "Game is not in playing state"
    },
    {
      "code": 6001,
      "name": "gameAlreadyStarted",
      "msg": "Game has already started"
    }
  ],
  "types": [
    {
      "name": "gameState",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Player who owns this game"
            ],
            "type": "pubkey"
          },
          {
            "name": "score",
            "docs": [
              "Current score"
            ],
            "type": "u64"
          },
          {
            "name": "highScore",
            "docs": [
              "Highest score achieved"
            ],
            "type": "u64"
          },
          {
            "name": "gameStatus",
            "docs": [
              "Current game status"
            ],
            "type": {
              "defined": {
                "name": "gameStatus"
              }
            }
          },
          {
            "name": "birdY",
            "docs": [
              "Bird Y position (fixed-point, scaled by 1000)"
            ],
            "type": "i32"
          },
          {
            "name": "birdVelocity",
            "docs": [
              "Bird velocity (fixed-point, scaled by 1000)"
            ],
            "type": "i32"
          },
          {
            "name": "frameCount",
            "docs": [
              "Frame counter for timing"
            ],
            "type": "u64"
          },
          {
            "name": "lastUpdate",
            "docs": [
              "Last update timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "pipes",
            "docs": [
              "Pipe data (up to 5 pipes on screen)"
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "pipe"
                  }
                },
                5
              ]
            }
          },
          {
            "name": "nextPipeSpawnX",
            "docs": [
              "X position for next pipe spawn"
            ],
            "type": "i32"
          },
          {
            "name": "seed",
            "docs": [
              "Random seed for pipe generation"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "gameStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "notStarted"
          },
          {
            "name": "playing"
          },
          {
            "name": "gameOver"
          }
        ]
      }
    },
    {
      "name": "pipe",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "x",
            "docs": [
              "X position of pipe"
            ],
            "type": "i32"
          },
          {
            "name": "gapY",
            "docs": [
              "Y position of gap center"
            ],
            "type": "i32"
          },
          {
            "name": "passed",
            "docs": [
              "Whether bird has passed this pipe"
            ],
            "type": "bool"
          },
          {
            "name": "active",
            "docs": [
              "Whether pipe is active"
            ],
            "type": "bool"
          }
        ]
      }
    }
  ]
};
