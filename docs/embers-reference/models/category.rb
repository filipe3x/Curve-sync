class Category < ApplicationRecord
  include Mongoid::Document
  include Mongoid::Timestamps
  include Mongoid::Paperclip

  field :name, type: String
  field :entities, type: Array, default: []
  field :created_at, type: DateTime
  field :updated_at, type: DateTime

  validates :name, presence: true, uniqueness: true
  #validates :icon, presence: false

  has_many :expenses

  has_mongoid_attached_file :icon, default_url: "/images/missing.png"
  validates_attachment :icon, content_type: { content_type: ['image/jpeg', 'image/png'] }

  def total_spent
    expenses.sum(:amount)
  end

  def to_json
    {
      id: id.to_s,
      name: name,
      entities: entities,
      created_at: created_at,
      updated_at: updated_at,
      icon: icon.url,
      total_spent: total_spent
    }
  end

end